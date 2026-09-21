// services/ai/gateway.js
//
// A PORTA ÚNICA DE IA DO OFFICE.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE ELA RESOLVE
//
// Antes: nove arquivos instanciavam o SDK do Gemini, cada um com a sua rotação
// de chave e o seu retry, e o formato dele aparecia em 41 pontos de chamada.
// Quatro consequências, todas medidas nesta base:
//
//   - Trocar de fornecedor era reescrever o produto.
//   - O SDK aposentado tinha que ser trocado em nove lugares.
//   - A conta de tokens era impossível: cada ponto media (ou não media) do seu
//     jeito, e o chat - o maior consumidor - não media nada.
//   - Cada lugar aprendeu sozinho, e tarde, a diferença entre "chave estourou"
//     e "modelo cheio". O validador levou um bug caro por causa disso.
//
// Agora: `chamar()` e `conversa()` são a única porta. Quem escolhe o fornecedor
// é a TELA (ai_routes por contexto); quem traduz o formato é o adaptador; quem
// conta token é aqui.
//
// ─────────────────────────────────────────────────────────────────────────────
// A ORDEM DAS TENTATIVAS, E POR QUE ELA É ASSIM
//
// Para cada MODELO do pool, tenta cada CHAVE. A causa do erro decide o passo:
//
//   credencial  para na hora. Nenhuma tentativa conserta chave errada, e
//               insistir só multiplica o mesmo 401 no log.
//   modelo      pula para o PRÓXIMO MODELO. Modelo aposentado não volta.
//   quota       esfria a CHAVE e vai para a próxima.
//   ritmo       espera e repete na MESMA chave (é ritmo, não saldo).
//   sobrecarga  espera crescente e repete na MESMA chave.
//   timeout     uma repetição; insistir com o mesmo prompt gigante não ajuda.
//
// Essa tabela é a memória do que já quebrou aqui: tratar tudo como transiente
// punha a chave em cooldown por um 503 e matava a análise em dois segundos.

import { adaptadorDe, ErroDeProvedor } from './adapters.js';
import { reservarResposta } from './normalize.js';
import { provedorDe, chavesDe, registrarChecagem } from './providers.js';

/** Espera entre tentativas no mesmo modelo, crescente. */
const ESPERAS = [800, 2500, 6000];
const COOLDOWN_MS = 5 * 60 * 1000;

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// Chave em quarentena: providerKey::índice → quando volta.
const _cooldown = new Map();
const gelada = (pk, i) => (_cooldown.get(`${pk}::${i}`) || 0) > Date.now();
const gelar = (pk, i) => _cooldown.set(`${pk}::${i}`, Date.now() + COOLDOWN_MS);

/** Para teste e para quando o admin troca a credencial na tela. */
export function limparCooldowns() { _cooldown.clear(); }

/**
 * Resolve o provedor, o pool de modelos e as chaves de um contexto.
 * Erros aqui são de CONFIGURAÇÃO e vêm com a mensagem que diz o que fazer.
 */
async function resolver(contexto, uso, { modelos: override = null } = {}) {
    const r = await provedorDe(contexto);
    if (r.erro) throw new ErroDeProvedor(r.erro, { causa: r.pausado ? 'pausado' : 'config' });

    // ESCAPE HATCH, e só isso. Existe porque o chat da Eme tem um seletor
    // rápido/inteligente por pessoa, com pools que já vêm configurados no
    // Cérebro. Sem o override, migrar o chat para a porta única APAGARIA esse
    // seletor - uma regressão escondida dentro de uma mudança de infraestrutura.
    //
    // A tela de Conexões continua dona do PADRÃO: quem não passa override usa
    // o pool dela, e um override vazio também. O que o chamador escolhe aqui é
    // a faixa, não o fornecedor.
    const modelos = (Array.isArray(override) && override.length)
        ? override
        : (r.models?.[uso] || []);
    if (!modelos.length) {
        throw new ErroDeProvedor(
            `O provedor "${r.provider.label}" não tem modelo configurado para "${uso}". Ajuste em Configurações > Conexões de IA.`,
            { causa: 'config' });
    }

    const chaves = chavesDe(r.provider);
    if (!chaves.length) {
        throw new ErroDeProvedor(
            `O provedor "${r.provider.label}" está sem chave de API. Cadastre uma em Configurações > Conexões de IA.`,
            { causa: 'credencial' });
    }

    return { provider: r.provider, modelos, chaves, adaptador: adaptadorDe(r.provider.kind) };
}

/**
 * Uma chamada completa, com fallback de modelo e rotação de chave.
 *
 * @param {string} contexto  'office_chat' | 'relatorios' | 'eme_atende' | 'validador' | 'utilidades'
 * @param {string} uso       'chat' | 'json' | 'visao'
 * @returns {Promise<{texto, tools, fim, uso, modelo, provider}>}
 */
export async function chamar(contexto, uso, opcoes = {}) {
    // `modelos` é escolha do POOL e não parâmetro de chamada: fica fora do que
    // vai para o adaptador, senão viraria um campo desconhecido no corpo HTTP
    // de quem quer que esteja atendendo.
    const { modelos: override, ...paraOAdaptador } = opcoes;
    const { provider, modelos, chaves, adaptador } = await resolver(contexto, uso, { modelos: override });
    let ultimo = null;

    for (const modelo of modelos) {
        let sobrecargas = 0;
        let timeouts = 0;

        for (let i = 0; i < chaves.length; i++) {
            if (gelada(provider.key, i) && chaves.length > 1) continue;

            try {
                const r = await adaptador.chamar({
                    base: provider.base_url,
                    chave: chaves[i],
                    extra: provider.extra,
                    modelo,
                    ...paraOAdaptador,
                    stream: false,
                });
                return { ...r, modelo, provider: provider.key, kind: provider.kind };
            } catch (err) {
                ultimo = err;
                const causa = err?.causa || 'fatal';

                // Credencial errada não se resolve tentando de novo, e o recado
                // precisa chegar limpo em vez de virar "falha geral".
                if (causa === 'credencial') throw err;

                if (causa === 'modelo') break;               // próximo modelo
                if (causa === 'quota') { gelar(provider.key, i); continue; }
                if (causa === 'ritmo' || causa === 'sobrecarga') {
                    await esperar(ESPERAS[Math.min(sobrecargas++, ESPERAS.length - 1)]);
                    i--;                                     // mesma chave
                    if (sobrecargas > ESPERAS.length) { sobrecargas = 0; continue; }
                    continue;
                }
                if (causa === 'timeout') {
                    // Uma repetição só: prompt grande demais não encolhe
                    // sozinho, e insistir queima o relógio de quem espera.
                    if (timeouts++ === 0) { i--; continue; }
                    break;
                }
                // Fatal: tenta a próxima chave, depois o próximo modelo.
            }
        }
    }

    throw ultimo || new ErroDeProvedor('Nenhum modelo respondeu.', { causa: 'fatal' });
}

/**
 * JSON estruturado. O atalho mais usado fora do chat (triagem de e-mail,
 * digests, insights, leitura de odômetro, extração de cartão CNPJ).
 *
 * Devolve `null` em vez de lançar: todo chamador de JSON no sistema já tem um
 * caminho determinístico de reserva, e derrubar a tela por causa de um resumo
 * que não saiu seria pior que a tela sem o resumo.
 */
/**
 * Igual a `json()`, mas diz QUEM respondeu.
 *
 * Existe porque algumas telas mostram o modelo que gerou o conteúdo, e essa
 * informação parou de ser adivinhável no dia em que o fornecedor virou uma
 * linha na tela: o pool tem fallback, então o modelo que respondeu pode não
 * ser o primeiro da lista.
 *
 * @returns {Promise<{ dados: object|null, modelo: string|null, provider: string|null }>}
 */
export async function jsonDetalhado(contexto, prompt, { maxSaida = 2048, imagem = null, temperatura = null } = {}) {
    try {
        const partes = [{ texto: String(prompt || '') }];
        // A mídia vai na MESMA parte da pergunta: é assim que os três
        // fornecedores amarram "olhe esta imagem" ao texto que a acompanha.
        if (imagem?.data) partes[0].midia = imagem;
        const r = await chamar(contexto, imagem ? 'visao' : 'json', {
            historico: [{ papel: 'user', partes }],
            maxSaida,
            temperatura,
            json: true,
        });
        const quem = { modelo: r.modelo || null, provider: r.provider || null };
        const txt = String(r.texto || '').trim();
        if (!txt) return { dados: null, ...quem };

        let dados = null;
        try { dados = JSON.parse(txt); }
        catch {
            // Modelo que ignora o modo JSON costuma embrulhar em texto; o
            // recorte do primeiro objeto salva a chamada sem mascarar erro.
            const m = txt.match(/\{[\s\S]*\}/);
            dados = m ? JSON.parse(m[0]) : null;
        }
        return { dados, ...quem };
    } catch (err) {
        console.warn(`[ai/gateway.json:${contexto}]`, err?.message);
        return { dados: null, modelo: null, provider: null };
    }
}

/**
 * JSON de um prompt, ou `null`.
 *
 * `null` em QUALQUER falha, de propósito: os seis serviços que chamam daqui
 * têm caminho determinístico de reserva, e derrubar a operação porque a IA
 * ficou fora do ar seria trocar uma degradação por uma parada.
 */
export async function json(contexto, prompt, opcoes = {}) {
    const r = await jsonDetalhado(contexto, prompt, opcoes);
    return r.dados;
}

/** Texto simples, sem tools. */
export async function texto(contexto, prompt, { uso = 'json', maxSaida = 2048, system = '', temperatura = null } = {}) {
    const r = await chamar(contexto, uso, {
        system,
        historico: [{ papel: 'user', partes: [{ texto: String(prompt || '') }] }],
        maxSaida,
        temperatura,
    });
    return r.texto;
}

/** Vetor de um texto. Fornecedor sem embedding avisa em vez de devolver nada. */
export async function embed(contexto, texto, { dimensoes = null, tarefa = 'RETRIEVAL_DOCUMENT' } = {}) {
    const { provider, modelos, chaves, adaptador } = await resolver(contexto, 'embed');
    let ultimo = null;
    for (const modelo of modelos) {
        for (let i = 0; i < chaves.length; i++) {
            if (gelada(provider.key, i) && chaves.length > 1) continue;
            try {
                return await adaptador.embed({
                    base: provider.base_url, chave: chaves[i], extra: provider.extra,
                    modelo, texto: String(texto || '').slice(0, 8000), dimensoes, tarefa,
                });
            } catch (err) {
                ultimo = err;
                if (err?.causa === 'credencial') throw err;
                if (err?.causa === 'quota') gelar(provider.key, i);
                if (err?.causa === 'modelo') break;
            }
        }
    }
    throw ultimo || new ErroDeProvedor('Nenhum modelo de embedding respondeu.', { causa: 'fatal' });
}

/**
 * Conversa com tools, em stream.
 *
 * O histórico vive AQUI, no formato interno, e o adaptador traduz a cada envio.
 * É o que permite trocar de fornecedor no meio da vida do produto sem o chat
 * saber: quem chama recebe sempre os mesmos eventos normalizados.
 */
export async function conversa(contexto, { system = '', historico = [], tools = [], modoTool = 'auto', maxSaida = null, modelos: override = null } = {}) {
    const { provider, modelos, chaves, adaptador } = await resolver(contexto, 'chat', { modelos: override });
    const hist = [...historico];
    let modeloEscolhido = null;

    return {
        provider: provider.key,
        kind: provider.kind,
        get modelo() { return modeloEscolhido; },
        historico: hist,

        /** Acrescenta ao histórico sem chamar o modelo (resultado de tool). */
        anexar(mensagem) { hist.push(mensagem); },

        /**
         * Envia e devolve um iterador de eventos normalizados:
         *   { tipo:'texto', texto } | { tipo:'tool', id, nome, args }
         * Ao fim, `resultado()` traz o motivo da parada e o consumo.
         */
        async *enviar(mensagem, { modoTool: modoAgora = modoTool } = {}) {
            if (mensagem) hist.push(mensagem);

            let ultimo = null;
            // Visível para o catch: é ele que desfaz a reserva da tentativa
            // que morreu no meio do stream.
            let reservaAtual = null;
            for (const modelo of modelos) {
                for (let i = 0; i < chaves.length; i++) {
                    if (gelada(provider.key, i) && chaves.length > 1) continue;
                    try {
                        const { sse, leitor } = await adaptador.chamar({
                            base: provider.base_url, chave: chaves[i], extra: provider.extra,
                            modelo, system, historico: hist, tools,
                            modoTool: modoAgora, maxSaida, stream: true,
                        });
                        modeloEscolhido = modelo;

                        // O lugar da resposta é reservado ANTES de emitir: quem
                        // consome chama `enviar()` de dentro deste laço para
                        // devolver o resultado de uma tool, e sem a reserva esse
                        // resultado entraria no histórico ANTES da chamada que o
                        // originou - ordem que os três fornecedores recusam.
                        const reserva = reservarResposta(hist);
                        reservaAtual = reserva;
                        const { partes } = reserva;
                        for await (const bruto of sse) {
                            for (const ev of leitor.push(bruto)) {
                                if (ev.tipo === 'texto') partes.push({ texto: ev.texto });
                                if (ev.tipo === 'tool') partes.push({ tool: { id: ev.id, nome: ev.nome, args: ev.args } });
                                yield ev;
                            }
                        }
                        for (const ev of leitor.flush()) {
                            if (ev.tipo === 'tool') partes.push({ tool: { id: ev.id, nome: ev.nome, args: ev.args } });
                            yield ev;
                        }

                        // Turno que não produziu nada não deixa mensagem vazia
                        // no histórico: alguns fornecedores recusam, e todos se
                        // confundem com ela.
                        if (!partes.length) reserva.cancelar();
                        reservaAtual = null;

                        const r = leitor.resultado();
                        this._ultimo = { ...r, modelo, provider: provider.key };
                        return;
                    } catch (err) {
                        ultimo = err;
                        // A reserva some junto com a tentativa que falhou: deixá-la
                        // faria a próxima tentativa mandar uma resposta vazia do
                        // modelo no meio do histórico.
                        reservaAtual?.cancelar();
                        const causa = err?.causa || 'fatal';
                        if (causa === 'credencial') throw err;
                        if (causa === 'modelo') break;
                        if (causa === 'quota') { gelar(provider.key, i); continue; }
                        // Em stream não dá para repetir no meio: o texto já
                        // pode ter saído. Vai para a próxima chave/modelo.
                    }
                }
            }
            throw ultimo || new ErroDeProvedor('Nenhum modelo respondeu.', { causa: 'fatal' });
        },

        resultado() { return this._ultimo || { fim: null, uso: null }; },
    };
}

/**
 * Prova de vida de um provedor: toca em cada modelo do pool de chat.
 *
 * Mesma ideia da sonda do Validador, e pelo mesmo motivo: responder "este
 * fornecedor está de pé?" ANTES de alguém perguntar alguma coisa à Eme.
 */
export async function testarProvedor(provider) {
    const adaptador = adaptadorDe(provider.kind);
    const chaves = chavesDe(provider);
    const modelos = provider.models?.chat?.length ? provider.models.chat : Object.values(provider.models || {}).flat();

    if (!chaves.length) {
        const r = { status: 'down', erro: 'Sem chave de API cadastrada.', modelos: [] };
        await registrarChecagem(provider.id, r);
        return r;
    }
    if (!modelos.length) {
        const r = { status: 'down', erro: 'Sem modelo configurado.', modelos: [] };
        await registrarChecagem(provider.id, r);
        return r;
    }

    const resultados = [];
    for (const modelo of modelos.slice(0, 6)) {
        const t0 = Date.now();
        try {
            await adaptador.chamar({
                base: provider.base_url, chave: chaves[0], extra: provider.extra,
                modelo,
                historico: [{ papel: 'user', partes: [{ texto: 'ping' }] }],
                maxSaida: 16, stream: false, timeoutMs: 25000,
            });
            resultados.push({ model: modelo, ok: true, ms: Date.now() - t0 });
        } catch (err) {
            resultados.push({ model: modelo, ok: false, ms: Date.now() - t0, tipo: err?.causa || 'fatal', erro: String(err?.message || err).slice(0, 200) });
        }
    }

    const vivos = resultados.filter(r => r.ok);
    // Principal caído com reserva viva ainda valida, mas fora do desenho - e é
    // exatamente o caso do modelo aposentado, que precisa virar aviso antes de
    // a fila sentir.
    const status = !vivos.length ? 'down' : (vivos.length < resultados.length ? 'degraded' : 'ok');
    const erro = vivos.length === resultados.length ? null
        : resultados.filter(r => !r.ok).map(r => `${r.model}: ${r.tipo}`).join('; ');

    await registrarChecagem(provider.id, { status, erro, modelos: resultados });
    return { status, erro, modelos: resultados };
}

export { ErroDeProvedor };
export default { chamar, json, texto, embed, conversa, testarProvedor, limparCooldowns };

// services/OfficeAI/anchoring.js
//
// ANCORAGEM: o modelo REFERENCIA o dado em vez de digitar o número.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE ISTO EXISTE
//
// A trava anti-invenção de hoje (hallucinationGuard.js) é uma auditoria de
// texto: extrai número da prosa e pergunta se ele está no conjunto que veio das
// consultas. Três defeitos estruturais, nenhum deles resolvível com mais regex:
//
//   1. FALSO POSITIVO É O MODO DE FALHA DOMINANTE. São 200+ linhas de exceção
//      (horário, data por extenso, R$, dia do mês), e cada uma nasceu de uma
//      resposta CERTA bloqueada em produção. A lista nunca fecha, porque o uso
//      de número em linguagem natural é ilimitado.
//   2. O CONJUNTO AUTORITATIVO É GRANDE DEMAIS PARA SIGNIFICAR ALGO. Ele varre
//      o resultado inteiro; num retorno de 200 linhas por 10 campos qualquer
//      número de dois ou três dígitos encontra par. Precisão e recall caem pelo
//      mesmo mecanismo.
//   3. NÃO PEGA O ERRO MAIS CARO. A invenção que dói não é número inventado: é
//      número CERTO na entidade ERRADA ("a Ingá vendeu 143" quando 143 é da
//      Sarandi). Os dois valores estão no conjunto e a resposta passa limpa.
//
// A ancoragem inverte o ônus. O modelo escreve:
//
//     "A {{ref:r3.empreendimento}} lidera com {{ref:r3.vendas}} vendas."
//
// e o servidor troca pelas células reais antes de a pessoa ler. Daí:
//
//   - ZERO FALSO POSITIVO POR CONSTRUÇÃO. "08:30", "20 minutos", "31 de julho"
//     são prosa que o modelo escreve à vontade: não são referências, e nada as
//     audita.
//   - O ERRO CARO VIRA IMPOSSÍVEL. `r3.empreendimento` e `r3.vendas` saem da
//     MESMA LINHA. Não há como grudar o número de uma no nome de outra.
//   - REFERÊNCIA QUEBRADA É ERRO DURO. Não resolveu, não existe. Sem heurística,
//     sem limiar, sem discussão.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE ESTE MÓDULO NÃO RESOLVE
//
// O modelo precisa COLABORAR, e o Flash às vezes escreve número cru. Por isso a
// ancoragem nasce em modo SUAVE: as referências são resolvidas quando aparecem,
// e o que sobrar de número cru continua passando pela trava antiga. A `taxa de
// ancoragem` medida por turno é o que diz quando dá para apertar - trocar uma
// heurística por outra sem medir seria repetir o erro que este módulo corrige.
//
// Tudo aqui é puro: sem banco, sem rede, sem SDK (tests/emeAnchoring.test.mjs).

// ── Formato da referência ───────────────────────────────────────────────────
//
// `{{ref:r3.vendas}}` (célula de linha) ou `{{ref:v1}}` (valor avulso).
// As chaves duplas e o prefixo `ref:` foram escolhidos por serem improváveis em
// texto de negócio e fáceis de segurar num stream partido ao meio.
const REF_RE = /\{\{ref:([a-z]\d+(?:\.[a-zA-Z0-9_]+)?)\}\}/g;

/**
 * Onde o chunk pode ser cortado com segurança.
 *
 * Tentei fazer isto com um regex de "prefixo parcial" e ele errava justamente
 * o caso mais comum: `{{ref:r1.nome}` (só um fecha-chaves chegou) não casava
 * como pendência, e meio marcador ia para a tela. Varrer as posições é mais
 * longo de ler e não tem esse tipo de buraco.
 *
 * Regra: se existe um `{{` sem o `}}` correspondente, segura a partir dele; se
 * o chunk termina em `{`, segura esse caractere (pode virar `{{` no próximo).
 */
function pontoDeCorte(buf) {
    const abre = buf.lastIndexOf('{{');
    if (abre !== -1 && buf.indexOf('}}', abre) === -1) return abre;
    if (buf.endsWith('{')) return buf.length - 1;
    return buf.length;
}

// Sobra de referência que nunca fechou (stream cortado no meio). Some do texto
// em vez de virar lixo na tela.
const TRUNCADA_RE = /\{\{ref:[a-zA-Z0-9_.]*$/;

/** Chaves cujo array o modelo cita item a item. */
const COLECOES_CITAVEIS = ['rows', 'campanhas', 'cards', 'top3', 'kpis', 'pendencias', 'itens'];

/** Campos que são só mecânica de renderização e não valem citação. */
const NAO_CITAVEL = new Set(['ref', 'id', 'key', 'kind', 'visual', 'icon', 'icone', 'color', 'cor', 'route', 'rota', 'link', 'url']);

const ehEscalar = (v) => v == null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean';

// ── Formatação ──────────────────────────────────────────────────────────────

const NUM_BR = new Intl.NumberFormat('pt-BR');
const MOEDA_BR = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Como o valor aparece no texto.
 *
 * O servidor formata, não o modelo: é o que garante que o mesmo número saia
 * igual na frase e na tabela. `tipo` vem das colunas do bloco quando existe
 * (contrato de blocks.js); sem ele, número vira número em pt-BR e o resto sai
 * como está.
 */
export function formatarValor(valor, tipo) {
    if (valor == null || valor === '') return '';
    if (typeof valor === 'boolean') return valor ? 'sim' : 'não';

    const n = typeof valor === 'number' ? valor : Number(String(valor).replace(',', '.'));
    const ehNumero = Number.isFinite(n) && (typeof valor === 'number' || /^-?\d+(?:[.,]\d+)?$/.test(String(valor).trim()));

    switch (tipo) {
        case 'currency':
            return ehNumero ? MOEDA_BR.format(n) : String(valor);
        case 'percent':
            // O dado vem como 12.5 e não 0.125 no contrato de blocks.js.
            return ehNumero ? `${NUM_BR.format(n)}%` : String(valor);
        case 'number':
            return ehNumero ? NUM_BR.format(n) : String(valor);
        default:
            return ehNumero ? NUM_BR.format(n) : String(valor);
    }
}

// ── Registro ────────────────────────────────────────────────────────────────

/**
 * Percorre o que vai ao modelo e devolve DUAS coisas: uma cópia anotada, com o
 * id de citação em cada item, e o registro que resolve esses ids.
 *
 * A anotação é ADITIVA de propósito. Os resumos que o OfficeChatService monta
 * carregam instruções fortes que dependem do formato ("labels[0] é o maior"),
 * e mudar a forma para caber a citação quebraria essas instruções. Aqui só
 * entram campos novos: `ref` dentro de cada item e uma lista `citacoes` ao lado
 * do gráfico.
 *
 * @param {Array<object>} resumos  o que o modelo já recebe, um por consulta
 * @returns {{ resumos: Array, registro: Map<string, {valor, tipo, rotulo}>, total: number }}
 */
export function anotarParaCitacao(resumos = []) {
    const reg = criarRegistroDeCitacoes();
    const anotados = resumos.map(r => reg.anotar(r));
    return { resumos: anotados, registro: reg.registro, total: reg.registro.size };
}

/**
 * A mesma coisa, INCREMENTAL.
 *
 * O turno descobre as consultas uma a uma (a cadeia de tools), e cada resultado
 * vai ao modelo assim que chega. Os ids precisam ser únicos no turno INTEIRO,
 * senão a segunda consulta reescreveria `r1` da primeira e a referência
 * resolveria para o valor errado - que é o defeito exato que a ancoragem veio
 * evitar. Por isso os contadores vivem aqui, e não dentro de cada chamada.
 */
export function criarRegistroDeCitacoes() {
    const registro = new Map();
    let seqLinha = 0;
    let seqCategoria = 0;
    let seqValor = 0;

    const anotarItem = (item, tiposPorCampo) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
        const ref = `r${++seqLinha}`;
        const copia = { ref, ...item };
        for (const [campo, v] of Object.entries(item)) {
            if (!ehEscalar(v) || v === null || v === '') continue;
            if (NAO_CITAVEL.has(campo)) continue;
            registro.set(`${ref}.${campo}`, {
                valor: v,
                tipo: tiposPorCampo?.[campo] || null,
                rotulo: campo,
            });
        }
        return copia;
    };

    /** Tipos declarados pelas colunas do bloco, quando o resumo os trouxe. */
    const tiposDe = (obj) => {
        const cols = obj?.columns || obj?.dataset?.columns;
        if (!Array.isArray(cols)) return null;
        const out = {};
        for (const c of cols) if (c?.key) out[c.key] = c.type || null;
        return out;
    };

    const percorrer = (no, tiposHerdados) => {
        if (Array.isArray(no)) return no.map(x => percorrer(x, tiposHerdados));
        if (!no || typeof no !== 'object') return no;

        const tipos = tiposDe(no) || tiposHerdados;
        const saida = {};

        for (const [chave, valor] of Object.entries(no)) {
            if (COLECOES_CITAVEIS.includes(chave) && Array.isArray(valor)) {
                saida[chave] = valor.map(item => anotarItem(item, tipos));
                continue;
            }

            // Gráfico: `labels` e `data` são arrays PARALELOS e a ordem deles é
            // carregada de significado no prompt. Em vez de mexer neles, sai uma
            // lista de citação ao lado, com nome e valor já pareados - que é
            // justamente o par que o modelo erra quando escreve de cabeça.
            if (chave === 'labels' && Array.isArray(valor) && Array.isArray(no.data)) {
                saida.labels = valor;
                saida.citacoes_categorias = valor.map((nome, i) => {
                    const ref = `c${++seqCategoria}`;
                    registro.set(`${ref}.nome`, { valor: nome, tipo: 'text', rotulo: 'categoria' });
                    registro.set(`${ref}.valor`, { valor: no.data[i], tipo: 'number', rotulo: String(nome) });
                    return { ref, nome, valor: no.data[i] };
                });
                continue;
            }

            if (valor && typeof valor === 'object') {
                saida[chave] = percorrer(valor, tipos);
                continue;
            }

            saida[chave] = valor;
        }

        return saida;
    };

    /** Anota UM resumo e devolve a cópia que vai ao modelo. */
    const anotar = (resumo) => {
        const saida = percorrer(resumo, null);
        if (!saida || typeof saida !== 'object' || Array.isArray(saida)) return saida;

        // Escalares do topo (total, soma_total, indicadores). São os mais
        // citados de todos - "quantos ao todo?" - e os que o modelo mais
        // arredonda quando escreve de cabeça.
        const avulsos = [];
        for (const [chave, valor] of Object.entries(saida)) {
            if (typeof valor !== 'number') continue;
            if (NAO_CITAVEL.has(chave)) continue;
            const ref = `v${++seqValor}`;
            registro.set(ref, { valor, tipo: 'number', rotulo: chave });
            avulsos.push({ ref, o_que: chave, valor });
        }
        if (avulsos.length) saida.citacoes_valores = avulsos;
        return saida;
    };

    return { anotar, registro, get total() { return registro.size; } };
}

// ── Resolução ───────────────────────────────────────────────────────────────

/**
 * Troca `{{ref:...}}` pelo valor real.
 *
 * Referência que não resolve NÃO vira texto cru na tela: sai como reticências e
 * é contada. Quem decide o que fazer com ela é o chamador - uma reescrita
 * dirigida pelo registro, ou o resumo determinístico. Deixar `{{ref:r99.x}}`
 * aparecer seria trocar um erro invisível por um erro feio.
 *
 * @returns {{ texto, resolvidas: number, naoResolvidas: string[] }}
 */
export function resolverRefs(texto, registro, { marcadorFalha = '…' } = {}) {
    // Os números CRUS são contados ANTES da troca, e isso não é detalhe: depois
    // dela o valor resolvido vira um número no texto e seria contado como se o
    // modelo o tivesse digitado. Com o denominador inflado assim, uma resposta
    // 100% ancorada media 66% e o detector nunca seria pulado - ou seja, o ganho
    // central da ancoragem não apareceria nunca.
    const crus = contarNumerosCitaveis(texto);

    if (!texto || !(registro instanceof Map) || !registro.size) {
        const orfas = texto ? [...String(texto).matchAll(REF_RE)].map(m => m[1]) : [];
        return {
            texto: orfas.length ? String(texto).replace(REF_RE, marcadorFalha) : (texto || ''),
            resolvidas: 0,
            naoResolvidas: orfas,
            crus,
        };
    }

    let resolvidas = 0;
    const naoResolvidas = [];

    const saida = String(texto).replace(REF_RE, (_, id) => {
        const achado = registro.get(id);
        if (!achado) { naoResolvidas.push(id); return marcadorFalha; }
        resolvidas++;
        return formatarValor(achado.valor, achado.tipo);
    });

    return { texto: saida, resolvidas, naoResolvidas, crus };
}

/**
 * Filtro de stream para as referências.
 *
 * O texto chega em pedaços e uma referência pode ser partida ao meio
 * ("{{ref:r3.ven" | "das}}"). Sem segurar a ponta, a pessoa vê o marcador cru
 * piscar na tela. Guarda só o sufixo que AINDA PODE virar referência; todo o
 * resto sai na hora, e o stream continua parecendo stream.
 *
 * Mesmo desenho do makeBridgeFilter (buffer + push/flush), separado porque a
 * responsabilidade é outra e porque assim dá para testar sozinho.
 */
export function makeRefFilter(registro, { marcadorFalha = '…' } = {}) {
    let buf = '';
    let resolvidas = 0;
    // O bruto inteiro, e não um contador por pedaço: um número pode ser
    // partido entre dois chunks ("14" + "3"), e somar pedaço a pedaço contaria
    // dois números pequenos onde há um só.
    let bruto = '';
    const naoResolvidas = [];

    const resolver = (trecho) => {
        bruto += trecho;
        const r = resolverRefs(trecho, registro, { marcadorFalha });
        resolvidas += r.resolvidas;
        naoResolvidas.push(...r.naoResolvidas);
        return r.texto;
    };

    return {
        push(chunk) {
            buf += String(chunk ?? '');
            const corte = pontoDeCorte(buf);
            const pronto = buf.slice(0, corte);
            buf = buf.slice(corte);
            return pronto ? resolver(pronto) : '';
        },
        /**
         * O que sobrou no fim do stream. Referência que ficou pela metade é
         * DESCARTADA e contada: o modelo parou no meio dela, então não há valor
         * para colocar ali - e deixar "{{ref:r1.no" aparecer seria trocar um
         * erro invisível por um erro feio.
         */
        flush() {
            let resto = buf;
            buf = '';
            if (!resto) return '';
            const truncada = resto.match(TRUNCADA_RE);
            if (truncada) {
                naoResolvidas.push(`${truncada[0].slice(7)}(truncada)`);
                resto = resto.slice(0, truncada.index) + marcadorFalha;
            }
            return resolver(resto);
        },
        stats() {
            return {
                resolvidas,
                naoResolvidas: [...naoResolvidas],
                // Números que o modelo DIGITOU (não vieram de referência).
                crus: contarNumerosCitaveis(bruto),
            };
        },
    };
}

// ── Medida ──────────────────────────────────────────────────────────────────

/**
 * Quanto da resposta está ancorado.
 *
 * É a métrica que decide o futuro da trava antiga: enquanto a taxa for baixa, o
 * detector de texto ainda é a rede de segurança; quando ela encostar em 1, ele
 * vira peso morto e sai. Medir antes de trocar é exatamente o que faltou na
 * primeira versão da trava.
 *
 * Recebe a CONTAGEM de números crus (do texto antes da resolução), nunca o
 * texto final: depois da troca o valor resolvido é indistinguível de um número
 * digitado, e a taxa sairia sempre abaixo de 1.
 *
 * O denominador ignora o que NUNCA deveria ser referência (ano, horário,
 * percentual solto, número de um dígito), senão a taxa nunca chegaria perto de
 * 1 e não serviria de régua para nada.
 */
export function taxaDeAncoragem(crus, resolvidas) {
    const total = (Number(crus) || 0) + (Number(resolvidas) || 0);
    if (!total) return null;                 // resposta sem número: nada a medir
    return (Number(resolvidas) || 0) / total;
}

/** Números em prosa que PODERIAM ter vindo de uma consulta. */
export function contarNumerosCitaveis(texto) {
    if (!texto) return 0;
    let n = 0;
    const re = /\b\d{1,3}(?:[.\s]\d{3})*(?:,\d+)?\b|\b\d+(?:[,.]\d+)?\b/g;
    let m;
    while ((m = re.exec(texto)) !== null) {
        const bruto = m[0];
        const valor = Number(bruto.replace(/\./g, '').replace(',', '.'));
        if (!Number.isFinite(valor)) continue;
        if (valor < 10) continue;                       // "2 dias", "3 itens"
        if (valor >= 1900 && valor <= 2100) continue;   // ano
        const antes = texto.slice(Math.max(0, m.index - 2), m.index);
        const depois = texto.slice(m.index + bruto.length, m.index + bruto.length + 3);
        if (/[:h/\-]$/i.test(antes)) continue;          // horário e data
        if (/^[:h/\-]/i.test(depois)) continue;
        n++;
    }
    return n;
}

export default {
    anotarParaCitacao,
    criarRegistroDeCitacoes,
    resolverRefs,
    makeRefFilter,
    taxaDeAncoragem,
    contarNumerosCitaveis,
    formatarValor,
};

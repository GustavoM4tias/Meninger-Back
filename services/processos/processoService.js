// services/processos/processoService.js
//
// A camada de banco do motor de processos. Toda a DECISÃO mora nos módulos
// puros ao lado (autonomia.js, escopo.js, propostas.js); aqui é leitura,
// gravação e a ordem em que as coisas acontecem.
//
// ─────────────────────────────────────────────────────────────────────────────
// A REGRA QUE ATRAVESSA O ARQUIVO INTEIRO
//
// Nada entra no mapa da empresa sem uma pessoa. Em nenhum degrau de autonomia,
// nem quando a evidência é esmagadora. O motor observa, minera e PROPÕE; quem
// transforma proposta em regra é `decidirProposta`, e ela só roda com um
// `userId` atrás.
//
// É o mesmo princípio que o MemoryTools já usa para a memória pessoal da Eme.
// A diferença é a aposta: ali o erro vira uma preferência estranha de uma
// pessoa, aqui vira uma regra que o sistema inteiro passa a seguir.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import {
    efetivo, permite, podeSubir, avaliarPromocao, avaliarRebaixamento,
    nivelValido, NIVEIS, ROTULOS,
} from './autonomia.js';
import { alcanceDaEvidencia, dentroDoEscopo, escopoDaObservacao } from './escopo.js';
import { avaliarProposta, ordenarFila, PADROES } from './propostas.js';
import { ativas, revogadas, acharRegra, revogar, restaurar, resumir } from './regras.js';
import { montarTrilha, resumoDeSaude } from './trilha.js';

const {
    ProcessoDefinicao, ProcessoObservacao, ProcessoProposta, ProcessoAcao, ProcessoSettings,
} = db;

const erro400 = (msg) => { const e = new Error(msg); e.expose = 400; throw e; };
const erro404 = (msg) => { const e = new Error(msg); e.expose = 404; throw e; };

// ── Settings ─────────────────────────────────────────────────────────────────

const EDITAVEIS = [
    'mineracao_enabled', 'mineracao_cron',
    'min_evidencias', 'min_confianca', 'limiar_duplicata', 'limiar_conflito', 'max_por_dia',
    'min_empreendimentos', 'min_cidades',
    'promo_min_aprovadas', 'promo_min_dias', 'promo_max_recusadas',
    'retencao_observacao_dias', 'notify_user_ids',
];

/** Inteiro dentro de uma faixa, com a mensagem que diz o porquê do limite. */
function inteiro(v, { min, max, campo }) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) erro400(`${campo}: informe um número.`);
    if (n < min || n > max) erro400(`${campo}: use um valor entre ${min} e ${max}.`);
    return n;
}

function fracao(v, { campo, min = 0, max = 1 }) {
    const n = Number(v);
    if (!Number.isFinite(n)) erro400(`${campo}: informe um número.`);
    if (n < min || n > max) erro400(`${campo}: use um valor entre ${min} e ${max}.`);
    return Number(n.toFixed(3));
}

export function sanitizeSettings(patch = {}) {
    const out = {};
    for (const key of EDITAVEIS) {
        if (!(key in patch)) continue;
        const v = patch[key];

        switch (key) {
            case 'mineracao_enabled':
                out[key] = Boolean(v);
                break;

            case 'mineracao_cron':
                out[key] = String(v || '').trim().slice(0, 40) || '0 5 * * *';
                break;

            // O portão da fila. Afrouxar é permitido - é decisão da operação -
            // mas o piso existe: abaixo de 3 casos o motor vira gerador de
            // palpite, e uma fila de palpite é uma fila que ninguém lê.
            case 'min_evidencias':
                out[key] = inteiro(v, { min: 3, max: 200, campo: 'Evidência mínima' });
                break;

            // Teto de 20: mais que isso não é uma fila, é um relatório, e a
            // tela deixa de ser algo que se resolve numa sentada.
            case 'max_por_dia':
                out[key] = inteiro(v, { min: 1, max: 20, campo: 'Propostas por dia' });
                break;

            case 'min_confianca':
                out[key] = fracao(v, { campo: 'Confiança mínima', min: 0.1 });
                break;

            case 'limiar_duplicata':
                out[key] = fracao(v, { campo: 'Limiar de duplicata', min: 0.3 });
                break;

            case 'limiar_conflito':
                out[key] = fracao(v, { campo: 'Limiar de conflito', min: 0.1 });
                break;

            // A largura que uma regra precisa para virar DA EMPRESA. Baixar
            // para 1 é desligar a trava contra vazamento pela regra, então o
            // piso é 2 e a tela diz o que o número significa.
            case 'min_empreendimentos':
                out[key] = inteiro(v, { min: 2, max: 50, campo: 'Empreendimentos mínimos' });
                break;

            case 'min_cidades':
                out[key] = inteiro(v, { min: 1, max: 20, campo: 'Cidades mínimas' });
                break;

            case 'promo_min_aprovadas':
                out[key] = inteiro(v, { min: 3, max: 500, campo: 'Aprovações para promover' });
                break;

            case 'promo_min_dias':
                out[key] = inteiro(v, { min: 3, max: 365, campo: 'Dias para promover' });
                break;

            case 'promo_max_recusadas':
                out[key] = inteiro(v, { min: 0, max: 50, campo: 'Recusas toleradas' });
                break;

            case 'retencao_observacao_dias':
                out[key] = inteiro(v, { min: 30, max: 1095, campo: 'Retenção de observações' });
                break;

            case 'notify_user_ids': {
                const ids = (Array.isArray(v) ? v : []).map(Number).filter(Number.isInteger);
                out[key] = [...new Set(ids)].slice(0, 20);
                break;
            }
        }
    }
    return out;
}

let _cfg = null;
let _cfgAt = 0;
const TTL = 30 * 1000;

export function invalidarCache() { _cfg = null; _cfgAt = 0; }

/**
 * A configuração do módulo. Cai nos padrões do código quando o banco não
 * responde: o motor é acessório, e derrubar a observação porque a linha de
 * settings sumiu seria perder o dado justamente no incidente.
 */
export async function getSettings() {
    if (_cfg && Date.now() - _cfgAt < TTL) return _cfg;
    try {
        const [row] = await ProcessoSettings.findOrCreate({ where: { id: 1 }, defaults: { id: 1 } });
        const plain = row.get({ plain: true });
        _cfg = {
            ...plain,
            min_confianca: Number(plain.min_confianca),
            limiar_duplicata: Number(plain.limiar_duplicata),
            limiar_conflito: Number(plain.limiar_conflito),
        };
        _cfgAt = Date.now();
        return _cfg;
    } catch (err) {
        console.warn('[processos] settings indisponíveis, usando padrões:', err?.message);
        return { ...PADROES, mineracao_enabled: true, min_empreendimentos: 3, min_cidades: 2 };
    }
}

export async function salvarSettings(patch, userId = null) {
    const limpo = sanitizeSettings(patch);
    if (!Object.keys(limpo).length) erro400('Nada para salvar.');
    if (userId) limpo.updated_by = userId;
    const [row] = await ProcessoSettings.findOrCreate({ where: { id: 1 }, defaults: { id: 1 } });
    await row.update(limpo);
    invalidarCache();
    return row.get({ plain: true });
}

// ── Processos ────────────────────────────────────────────────────────────────

export async function listarProcessos() {
    const rows = await ProcessoDefinicao.findAll({
        order: [['ordem', 'ASC'], ['id', 'ASC']], raw: true,
    });
    // `efetivo` e `degraus` vão prontos para a tela: deixar o front recalcular
    // o degrau a partir de autonomia + teto é como UI e API divergem, e aqui
    // divergir significa a tela dizer que o processo age quando ele não age.
    return rows.map(p => {
        // A tela NUNCA recebe o JSONB cru: `resumir` é quem decide o que
        // aparece, e é ele que carrega o estado ("em uso", "nunca
        // consultada") que muda a decisão de quem lê.
        const vivas = ativas(p.regras);
        return {
            ...p,
            regras: vivas.map(resumir),
            regras_revogadas: revogadas(p.regras).map(resumir),
            autonomia_efetiva: efetivo(p),
            pode_propor: permite(p, 'propor'),
            pode_executar: permite(p, 'executar'),
            regras_n: vivas.length,
        };
    });
}

export async function acharProcesso(key) {
    const row = await ProcessoDefinicao.findOne({ where: { key: String(key || '') } });
    if (!row) erro404('Processo não encontrado.');
    return row;
}

const CAMPOS_PROCESSO = ['nome', 'descricao', 'gatilho', 'etapas', 'excecoes', 'enabled', 'ordem', 'rota'];

/**
 * Edita um processo. A autonomia NÃO passa por aqui de propósito: tem rota
 * própria, porque subir degrau é uma decisão e não pode acontecer de carona
 * numa correção de texto da etapa.
 */
export async function salvarProcesso(key, patch = {}, userId = null) {
    const row = await acharProcesso(key);
    const out = {};

    for (const campo of CAMPOS_PROCESSO) {
        if (!(campo in patch)) continue;
        if (campo === 'gatilho') out.gatilho = (patch.gatilho && typeof patch.gatilho === 'object') ? patch.gatilho : {};
        else if (campo === 'etapas') out.etapas = Array.isArray(patch.etapas) ? patch.etapas.slice(0, 40) : [];
        else if (campo === 'enabled') out.enabled = !!patch.enabled;
        else if (campo === 'ordem') out.ordem = inteiro(patch.ordem, { min: 0, max: 999, campo: 'Ordem' });
        else out[campo] = String(patch[campo] ?? '').slice(0, campo === 'nome' ? 160 : 8000) || null;
    }

    if (patch.nome !== undefined && !out.nome) erro400('O processo precisa de um nome.');
    if (!Object.keys(out).length) erro400('Nada para salvar.');

    if (userId) out.updated_by = userId;
    out.versao = (row.versao || 1) + 1;
    await row.update(out);
    return row.get({ plain: true });
}

/**
 * Troca o degrau de autonomia. Rota separada, e com o motivo na resposta.
 *
 * `teto` só muda quando vem explícito: subir o limite máximo nunca pode ser
 * efeito colateral de aprovar uma sugestão de promoção.
 */
export async function trocarAutonomia(key, { autonomia, autonomia_teto, nota } = {}, userId = null) {
    const row = await acharProcesso(key);
    const out = {};

    if (autonomia_teto !== undefined) {
        if (!nivelValido(autonomia_teto)) erro400('Teto de autonomia desconhecido.');
        out.autonomia_teto = autonomia_teto;
        // Baixar o teto abaixo do degrau atual puxa o degrau junto. Sem isto,
        // o processo ficaria gravado acima do próprio limite - e a leitura por
        // `efetivo()` esconderia a inconsistência em vez de resolvê-la.
        if (NIVEIS.indexOf(row.autonomia) > NIVEIS.indexOf(autonomia_teto)) {
            out.autonomia = autonomia_teto;
        }
    }

    if (autonomia !== undefined) {
        const teto = out.autonomia_teto || row.autonomia_teto;
        const atual = row.autonomia;
        // Descer é sempre livre: recuar depressa nunca é o risco.
        if (NIVEIS.indexOf(autonomia) > NIVEIS.indexOf(atual)) {
            const v = podeSubir(atual, autonomia, teto);
            if (!v.ok) erro400(v.motivo);
        } else if (!nivelValido(autonomia)) {
            erro400('Degrau de autonomia desconhecido.');
        }
        out.autonomia = autonomia;
    }

    if (nota !== undefined) out.autonomia_nota = String(nota || '').slice(0, 2000) || null;
    if (!Object.keys(out).length) erro400('Nada para alterar.');
    if (userId) out.updated_by = userId;

    await row.update(out);
    const plain = row.get({ plain: true });
    return { ...plain, autonomia_efetiva: efetivo(plain) };
}

// ── Observação ───────────────────────────────────────────────────────────────

/**
 * Registra o que aconteceu. É a porta de entrada do aprendizado.
 *
 * Acontece em QUALQUER degrau, inclusive 'observar' e inclusive com o processo
 * desligado - é o que permite religar um processo sabendo o que se passou
 * enquanto ele estava fora. Nunca lança: uma observação perdida é um caso a
 * menos no aprendizado; uma exceção aqui derruba o fluxo comercial que a
 * chamou, e esse fluxo é o que importa.
 */
export async function registrarObservacao(processo_key, dados = {}) {
    try {
        const escopo = escopoDaObservacao(dados);
        await ProcessoObservacao.create({
            processo_key: String(processo_key || '').slice(0, 60),
            caso_tipo: dados.caso_tipo ? String(dados.caso_tipo).slice(0, 40) : null,
            caso_ref: dados.caso_ref ? String(dados.caso_ref).slice(0, 120) : null,
            cv_ids: escopo.cv_ids,
            erp_ids: escopo.erp_ids,
            cidades: escopo.cidades,
            user_id: Number.isInteger(dados.user_id) ? dados.user_id : null,
            visto: (dados.visto && typeof dados.visto === 'object') ? dados.visto : {},
            acao: dados.acao ? String(dados.acao).slice(0, 4000) : null,
            resultado: dados.resultado ? String(dados.resultado).slice(0, 40) : null,
            occurred_at: dados.occurred_at || new Date(),
        });
        return true;
    } catch (err) {
        console.warn(`[processos] observação não registrada (${processo_key}):`, err?.message);
        return false;
    }
}

/** Observações de um processo, das mais novas para as mais antigas. */
export async function observacoesDe(processo_key, { limite = 500, desde = null } = {}) {
    const where = { processo_key };
    if (desde) where.occurred_at = { [Op.gte]: desde };
    return ProcessoObservacao.findAll({
        where, order: [['occurred_at', 'DESC']], limit: Math.min(2000, limite), raw: true,
    });
}

// ── Propostas ────────────────────────────────────────────────────────────────

/**
 * Passa uma proposta pelo portão e grava o desfecho.
 *
 * Duplicata e fraca também são GRAVADAS, com o status certo. É o que permite a
 * proposta fraca de hoje virar a regra boa do mês que vem, e é o que faz a
 * tela conseguir mostrar "o motor viu isto 40 vezes e ainda não tem evidência
 * para propor" em vez de simplesmente não mostrar nada.
 */
export async function registrarProposta({ processo_key, texto, confianca, observacoes = [], tipo = 'nova_regra' }) {
    const cfg = await getSettings();

    const proc = await ProcessoDefinicao.findOne({ where: { key: processo_key }, raw: true });
    // Só as VIVAS entram na comparação. Uma regra revogada não pode silenciar
    // uma proposta como duplicata: se o padrão voltou, ele merece ser visto de
    // novo - foi exatamente por isso que a regra antiga saiu do mapa.
    const vigentes = ativas(proc?.regras).map((r, i) => ({
        id: r.id ?? i, texto: r.texto, processo_key,
    }));

    const veredito = avaliarProposta({ processo_key, texto, confianca, observacoes }, { ativas: vigentes, cfg });

    // Duplicata não vira item: a evidência reforça a regra que já existe. Ver
    // a mesma coisa de novo é informação sobre a regra antiga, não uma nova.
    if (veredito.classe === 'duplicata') {
        await reforcarRegra(processo_key, veredito.duplica, observacoes.length);
        return { ...veredito, gravada: false };
    }

    const status = veredito.aceita ? 'pendente' : 'parada';
    const alcance = veredito.alcance || alcanceDaEvidencia(observacoes, cfg);

    const row = await ProcessoProposta.create({
        processo_key, tipo, classe: veredito.classe,
        texto: String(texto).slice(0, 8000),
        confianca: Math.max(0, Math.min(1, Number(confianca) || 0)),
        evidencia: observacoes.map(o => o.id).filter(Boolean).slice(0, 500),
        evidencia_n: observacoes.length,
        alcance: alcance?.alcance || null,
        alcance_motivo: alcance?.motivo || null,
        conflita_com: veredito.conflita_com ?? null,
        status,
        motivo: veredito.motivo,
    });

    return { ...veredito, gravada: true, id: row.id };
}

/** Soma evidência a uma regra que já existe, sem criar item na fila. */
async function reforcarRegra(processo_key, regraId, quantos) {
    try {
        const row = await ProcessoDefinicao.findOne({ where: { key: processo_key } });
        if (!row) return;
        const regras = Array.isArray(row.regras) ? [...row.regras] : [];
        const i = regras.findIndex((r, idx) => (r.id ?? idx) === regraId);
        if (i < 0) return;
        regras[i] = {
            ...regras[i],
            evidencia_n: (Number(regras[i].evidencia_n) || 0) + (Number(quantos) || 0),
            reforcada_em: new Date().toISOString(),
        };
        await row.update({ regras });
    } catch (err) {
        console.warn('[processos] reforço de regra falhou:', err?.message);
    }
}

/**
 * A fila que o admin vê hoje.
 *
 * O corte do dia é do `ordenarFila` e não de um LIMIT no SQL: o que não coube
 * precisa continuar existindo como "adiada", porque é isso que garante que
 * nada se perde e que amanhã ela volta com um caso a mais de evidência.
 */
export async function filaDePropostas({ incluirParadas = false } = {}) {
    const cfg = await getSettings();
    const status = incluirParadas ? ['pendente', 'parada'] : ['pendente'];

    const rows = await ProcessoProposta.findAll({
        where: { status: { [Op.in]: status } },
        order: [['created_at', 'DESC']],
        limit: 500,
        raw: true,
    });

    const comContagem = rows.map(r => ({
        ...r,
        confianca: Number(r.confianca),
        observacoes: { length: r.evidencia_n },   // ordenarFila só olha o tamanho
    }));

    const pendentes = comContagem.filter(r => r.status === 'pendente');
    const { mostrar, adiadas } = ordenarFila(pendentes, cfg);

    return {
        mostrar: mostrar.map(({ observacoes, ...r }) => r),
        adiadas: adiadas.map(({ observacoes, ...r }) => r),
        paradas: comContagem.filter(r => r.status === 'parada').map(({ observacoes, ...r }) => r),
        max_por_dia: cfg.max_por_dia,
    };
}

/**
 * O único caminho que transforma proposta em regra da empresa.
 *
 * Exige `userId`: é a linha entre "o motor propôs" e "a empresa decidiu", e é
 * ela que faz o mapa continuar explicável seis meses depois.
 *
 * @param {'aprovar'|'recusar'} decisao
 */
export async function decidirProposta(id, decisao, userId, nota = '') {
    if (!userId) erro400('Proposta só vira regra com uma pessoa por trás.');
    if (!['aprovar', 'recusar'].includes(decisao)) erro400('Decisão inválida.');

    const prop = await ProcessoProposta.findByPk(id);
    if (!prop) erro404('Proposta não encontrada.');
    if (prop.status !== 'pendente') erro400(`Esta proposta já está como "${prop.status}".`);

    const comum = {
        decidido_por: userId,
        decidido_em: new Date(),
        decisao_nota: String(nota || '').slice(0, 2000) || null,
    };

    if (decisao === 'recusar') {
        await prop.update({ ...comum, status: 'recusada' });
        return { status: 'recusada' };
    }

    const proc = await ProcessoDefinicao.findOne({ where: { key: prop.processo_key } });
    if (!proc) erro404('O processo desta proposta não existe mais.');

    const regras = Array.isArray(proc.regras) ? [...proc.regras] : [];
    const novaRegra = {
        id: (regras.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0)) + 1,
        texto: prop.texto,
        // A procedência inteira, porque "de onde veio esta regra?" é a
        // pergunta que aparece quando alguém discorda dela.
        origem: 'aprendida',
        proposta_id: prop.id,
        evidencia_n: prop.evidencia_n,
        alcance: prop.alcance,
        alcance_motivo: prop.alcance_motivo,
        aprovada_por: userId,
        aprovada_em: new Date().toISOString(),
    };

    // Conflito aprovado SUBSTITUI a regra contraditória em vez de conviver com
    // ela. Deixar as duas no mapa é o defeito que o portão existe para evitar:
    // a Eme leria as duas e seguiria a que viesse primeiro.
    if (prop.classe === 'conflito' && prop.conflita_com != null) {
        const i = regras.findIndex((r, idx) => (r.id ?? idx) === prop.conflita_com);
        if (i >= 0) {
            novaRegra.substituiu = { texto: regras[i].texto, em: new Date().toISOString() };
            regras.splice(i, 1);
        }
    }

    regras.push(novaRegra);

    // O alcance do PROCESSO acompanha a regra mais estreita que ele carrega.
    // Uma regra de cidade dentro de um processo de alcance "empresa" agiria
    // fora do escopo dela - e é exatamente o caso que derruba para 'observar'.
    const patch = { regras, versao: (proc.versao || 1) + 1, updated_by: userId };
    if (prop.alcance && prop.alcance !== 'empresa' && proc.alcance === 'empresa') {
        patch.alcance = prop.alcance;
    }
    await proc.update(patch);
    await prop.update({ ...comum, status: 'aprovada' });

    return { status: 'aprovada', regra: novaRegra };
}

// ── Ações e rebaixamento ─────────────────────────────────────────────────────

/**
 * Registra (e autoriza) uma ação automática.
 *
 * Confere o degrau E o escopo ANTES de deixar passar. As duas checagens são
 * aqui, e não em quem chama, porque em quem chama elas seriam esquecidas na
 * terceira integração - e a que for esquecida é a que vira incidente.
 */
export async function registrarAcao(processo_key, { acao, alvo = {}, detalhe = {}, regra_id = null, executar }) {
    const proc = await ProcessoDefinicao.findOne({ where: { key: processo_key }, raw: true });
    if (!proc) erro404('Processo não encontrado.');

    const degrau = efetivo(proc);
    if (!permite(proc, 'executar')) {
        return { executou: false, motivo: `O processo está em "${ROTULOS[degrau]}" e não executa nada sozinho.` };
    }

    const escopo = dentroDoEscopo(proc, alvo);
    if (!escopo.ok) {
        // Tentar agir fora do escopo não é só recusar a ação: é o sinal de que
        // o processo entendeu errado o próprio alcance, e isso derruba o degrau.
        await aplicarRebaixamento(proc, 'fora_do_escopo');
        return { executou: false, motivo: `Fora do escopo: ${escopo.motivo}` };
    }

    let resultado = 'ok';
    let erroMsg = null;
    try {
        if (typeof executar === 'function') await executar();
    } catch (err) {
        resultado = 'erro';
        erroMsg = String(err?.message || err).slice(0, 2000);
    }

    const row = await ProcessoAcao.create({
        processo_key,
        autonomia_no_momento: degrau,
        acao: String(acao || 'acao').slice(0, 80),
        // Qual regra mandou fazer isso. Ação sem regra é ação sem justificativa
        // na auditoria, e é o que impede responder "por que ela fez isso?".
        regra_id: Number.isInteger(Number(regra_id)) ? Number(regra_id) : null,
        alvo_tipo: alvo.caso_tipo ? String(alvo.caso_tipo).slice(0, 40) : null,
        alvo_ref: alvo.caso_ref ? String(alvo.caso_ref).slice(0, 120) : null,
        detalhe: (detalhe && typeof detalhe === 'object') ? detalhe : {},
        resultado,
        erro: erroMsg,
    });

    if (resultado === 'erro') await aplicarRebaixamento(proc, 'erro');
    return { executou: resultado === 'ok', id: row.id, motivo: erroMsg || '' };
}

/**
 * Marca uma ação como desfeita. É o gatilho do rebaixamento automático.
 *
 * Não passa por aprovação e não espera lote, de propósito: o custo de rebaixar
 * à toa é uma semana pedindo confirmação de novo; o de não rebaixar é a
 * próxima ação errada sair sozinha, igual à que acabou de ser desfeita.
 */
export async function reverterAcao(id, userId, nota = '', tipo = 'revertida') {
    const acao = await ProcessoAcao.findByPk(id);
    if (!acao) erro404('Ação não encontrada.');
    if (acao.revertida) erro400('Esta ação já está marcada como desfeita.');

    await acao.update({
        revertida: true,
        revertida_por: userId || null,
        revertida_em: new Date(),
        revertida_nota: String(nota || '').slice(0, 2000) || null,
    });

    const proc = await ProcessoDefinicao.findOne({ where: { key: acao.processo_key }, raw: true });
    const reb = proc ? await aplicarRebaixamento(proc, tipo) : null;
    return { revertida: true, rebaixamento: reb };
}

async function aplicarRebaixamento(proc, tipo) {
    const r = avaliarRebaixamento(proc, tipo);
    if (!r.rebaixar) return r;
    try {
        await ProcessoDefinicao.update(
            { autonomia: r.para, autonomia_nota: r.motivo },
            { where: { key: proc.key } },
        );
        console.warn(`[processos] ${proc.key}: ${r.motivo}`);
    } catch (err) {
        console.warn('[processos] rebaixamento não gravado:', err?.message);
    }
    return r;
}

/**
 * Onde o motor já mereceria subir um degrau.
 *
 * Só SUGERE, e é lido pela tela. Existe porque, sem lembrete, o processo fica
 * em 'Propor' para sempre pedindo aprovação de coisa que acerta há meses - e o
 * admin nunca lembra de promover justamente porque está funcionando.
 */
export async function sugestoesDePromocao() {
    const cfg = await getSettings();
    const procs = await ProcessoDefinicao.findAll({ raw: true });
    const out = [];

    for (const p of procs) {
        const desde = new Date(Date.now() - cfg.promo_min_dias * 2 * 24 * 3600 * 1000);

        const [aprovadas, recusadas, revertidas, primeira] = await Promise.all([
            ProcessoProposta.count({ where: { processo_key: p.key, status: 'aprovada' } }),
            ProcessoProposta.count({ where: { processo_key: p.key, status: 'recusada', decidido_em: { [Op.gte]: desde } } }),
            ProcessoAcao.count({ where: { processo_key: p.key, revertida: true } }),
            ProcessoProposta.findOne({
                where: { processo_key: p.key, status: 'aprovada' },
                order: [['decidido_em', 'ASC']], raw: true,
            }),
        ]);

        const dias = primeira?.decidido_em
            ? Math.floor((Date.now() - new Date(primeira.decidido_em).getTime()) / 86400000)
            : 0;

        const r = avaliarPromocao(p, { aprovadas, recusadas, revertidas, dias }, {
            min_aprovadas: cfg.promo_min_aprovadas,
            min_dias: cfg.promo_min_dias,
            max_recusadas: cfg.promo_max_recusadas,
        });

        if (r.sugerir) out.push({ key: p.key, nome: p.nome, de: efetivo(p), para: r.proximo, motivo: r.motivo });
    }
    return out;
}

// ── Memória: revogar, auditar, enxergar ──────────────────────────────────────

/**
 * Tira uma regra do mapa.
 *
 * Fica em 'aprovar' (quem tem a tela), e não em admin, de propósito: quem viu
 * a regra errada precisa poder puxar o freio sem procurar ninguém. Puxar o
 * freio é sempre mais fácil que soltá-lo, e é assim que tem que ser.
 *
 * A regra NÃO some - fica marcada. Apagar destruiria a resposta para "por que
 * a Eme dizia isso em março?", que é a pergunta que aparece justamente quando
 * alguém percebe o erro.
 */
export async function revogarRegra(key, regraId, userId, motivo) {
    const row = await acharProcesso(key);
    const r = revogar(row.regras, regraId, { userId, motivo });
    if (!r.ok) erro400(r.erro);

    await row.update({ regras: r.regras, versao: (row.versao || 1) + 1, updated_by: userId });
    console.warn(`[processos] ${key}: regra ${regraId} revogada por ${userId}.`);
    return resumir(r.regra);
}

/** Devolve ao mapa uma regra revogada por engano. O histórico fica. */
export async function restaurarRegra(key, regraId, userId) {
    const row = await acharProcesso(key);
    const r = restaurar(row.regras, regraId, { userId });
    if (!r.ok) erro400(r.erro);

    await row.update({ regras: r.regras, versao: (row.versao || 1) + 1, updated_by: userId });
    return resumir(r.regra);
}

/**
 * A cadeia completa de UMA regra: quem aprovou, a proposta que a originou, os
 * casos que a sustentaram e as ações que ela moveu.
 *
 * É o que responde "como eu valido se isso está correto?". Sem ela, a regra é
 * uma frase com um número do lado, e número sem os casos por trás é exatamente
 * o tipo de coisa que se aprova sem conferir.
 */
export async function evidenciaDaRegra(key, regraId) {
    const proc = await ProcessoDefinicao.findOne({ where: { key }, raw: true });
    if (!proc) erro404('Processo não encontrado.');

    const regra = acharRegra(proc.regras, regraId);
    if (!regra) erro404('Regra não encontrada neste processo.');

    const proposta = regra.proposta_id
        ? await ProcessoProposta.findByPk(regra.proposta_id, { raw: true })
        : null;

    const ids = Array.isArray(proposta?.evidencia) ? proposta.evidencia : [];
    const casos = ids.length
        ? await ProcessoObservacao.findAll({
            where: { id: { [Op.in]: ids.slice(0, 200) } },
            order: [['occurred_at', 'DESC']],
            raw: true,
        })
        : [];

    // O que esta regra MOVEU. É a outra metade da validação: uma regra correta
    // que nunca moveu nada e uma incorreta que moveu trinta ações são problemas
    // de tamanhos muito diferentes.
    const acoes = await ProcessoAcao.findAll({
        where: { processo_key: key, regra_id: Number(regraId) },
        order: [['created_at', 'DESC']],
        limit: 100,
        raw: true,
    });

    return {
        regra: resumir(regra),
        proposta: proposta
            ? {
                id: proposta.id, classe: proposta.classe, motivo: proposta.motivo,
                alcance_motivo: proposta.alcance_motivo,
                criada_em: proposta.created_at, decidida_em: proposta.decidido_em,
                decisao_nota: proposta.decisao_nota,
            }
            : null,
        casos,
        casos_total: ids.length,
        acoes,
        acoes_revertidas: acoes.filter(a => a.revertida).length,
    };
}

/**
 * As ações automáticas. A tela que faltava para poder subir um processo
 * para "agir".
 *
 * Enquanto isto não existia, promover era pedir para a pessoa confiar sem ter
 * onde olhar nem onde puxar o freio - e essa é a promoção que ninguém deveria
 * fazer.
 */
export async function listarAcoes({ processo_key = null, limite = 100 } = {}) {
    const where = {};
    if (processo_key) where.processo_key = processo_key;

    const rows = await ProcessoAcao.findAll({
        where, order: [['created_at', 'DESC']],
        limit: Math.min(500, Math.max(1, Number(limite) || 100)),
        raw: true,
    });

    // O texto da regra vai junto: "notificou o corretor" sem a regra ao lado
    // não deixa ninguém julgar se a ação fazia sentido.
    const chaves = [...new Set(rows.map(r => r.processo_key))];
    const procs = chaves.length
        ? await ProcessoDefinicao.findAll({ where: { key: { [Op.in]: chaves } }, raw: true })
        : [];
    const porChave = new Map(procs.map(p => [p.key, p]));

    return rows.map(a => {
        const proc = porChave.get(a.processo_key);
        const regra = a.regra_id != null ? acharRegra(proc?.regras, a.regra_id) : null;
        return {
            ...a,
            processo_nome: proc?.nome || a.processo_key,
            regra_texto: regra?.texto || null,
            regra_revogada: !!regra?.revogada_em,
        };
    });
}

/** A trilha: o caminho, não o estado. */
export async function trilhaDe({ processo_key = null, dias = 45, limite = 120 } = {}) {
    const desde = new Date(Date.now() - Math.min(365, Math.max(1, Number(dias) || 45)) * 86400000);
    const filtro = processo_key ? { processo_key } : {};

    const [observacoes, propostas, acoes] = await Promise.all([
        ProcessoObservacao.findAll({
            where: { ...filtro, occurred_at: { [Op.gte]: desde } },
            attributes: ['processo_key', 'caso_tipo', 'resultado', 'occurred_at'],
            limit: 5000, raw: true,
        }),
        ProcessoProposta.findAll({
            where: { ...filtro, created_at: { [Op.gte]: desde } },
            limit: 500, raw: true,
        }),
        ProcessoAcao.findAll({
            where: { ...filtro, created_at: { [Op.gte]: desde } },
            limit: 500, raw: true,
        }),
    ]);

    return montarTrilha({ observacoes, propostas, acoes }, { limite });
}

/** O boletim do motor, semana a semana, com o diagnóstico do que fazer. */
export async function saudeDoMotor({ semanas = 8 } = {}) {
    const desde = new Date(Date.now() - (semanas + 1) * 7 * 86400000);

    const [observacoes, propostas, acoes] = await Promise.all([
        ProcessoObservacao.findAll({
            where: { occurred_at: { [Op.gte]: desde } },
            attributes: ['occurred_at'], limit: 20000, raw: true,
        }),
        ProcessoProposta.findAll({
            where: { created_at: { [Op.gte]: desde } },
            attributes: ['created_at', 'decidido_em', 'status'], limit: 2000, raw: true,
        }),
        ProcessoAcao.findAll({
            where: { created_at: { [Op.gte]: desde } },
            attributes: ['created_at', 'revertida_em'], limit: 2000, raw: true,
        }),
    ]);

    return resumoDeSaude({ observacoes, propostas, acoes }, { semanas });
}

/** Tudo o que a tela precisa, numa chamada. */
export async function paraTela() {
    // A saúde vem junto de propósito: é o número que decide se a pessoa deve
    // mexer nos Ajustes, e deixá-lo atrás de outra chamada significaria que
    // ninguém olharia até já estar cansado da fila.
    const [processos, fila, settings, promocoes, saude] = await Promise.all([
        listarProcessos(),
        filaDePropostas({ incluirParadas: true }),
        getSettings(),
        sugestoesDePromocao(),
        saudeDoMotor({ semanas: 8 }).catch(() => null),
    ]);
    return { processos, fila, settings, promocoes, saude, niveis: NIVEIS, rotulos: ROTULOS };
}

export default {
    revogarRegra, restaurarRegra, evidenciaDaRegra, listarAcoes, trilhaDe, saudeDoMotor,
    getSettings, salvarSettings, sanitizeSettings, invalidarCache,
    listarProcessos, salvarProcesso, trocarAutonomia,
    registrarObservacao, observacoesDe,
    registrarProposta, filaDePropostas, decidirProposta,
    registrarAcao, reverterAcao, sugestoesDePromocao, paraTela,
};

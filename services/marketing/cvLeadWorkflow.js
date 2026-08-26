// services/marketing/cvLeadWorkflow.js
//
// O workflow de LEAD do CV e a régua que decide o que pode ser mexido num lead
// que já existe.
//
// A régua vem do CV, não de uma lista escrita aqui: `GET /v1/cv/workflow/leads`
// devolve cada situação com `ordem` e `flags`, e o CV cria situação nova quando
// quer. Amarrar a classificação na ordem dele faz a régua sobreviver a isso.
//
//   frio     — flag `cancelada` (Descartado). Ninguém está trabalhando o lead.
//   morno    — ordem < ordemBlindada. Tem dono, mas ainda não qualificou.
//   blindado — ordem >= ordemBlindada (Lead Qualificado em diante), OU situação
//              desconhecida, OU o CV fora do ar.
//
// A ordem que o CV publica hoje (25/08/2026):
//   0 Novo Lead · 1 Aguardando Atendimento Corretor · 2 1ª e 2ª Tentativa
//   3 Em Atendimento · 4 Lead Qualificado · 5 Em Negociação · 6 Em Análise de
//   Crédito · 7 Com Reserva · 8 Venda Realizada · 9 Descartado · 11 Atendimento
//   Externo
//
// Desconhecida cair em blindado é de propósito: o erro seguro é não mexer.

import apiCv from '../../lib/apiCv.js';
import MarketingConfigService from './MarketingConfigService.js';

const CACHE_MS = 10 * 60 * 1000;
let cache = null;   // { em, lista }

export const FAIXA = { FRIO: 'frio', MORNO: 'morno', BLINDADO: 'blindado' };

/** Corte padrão: "Lead Qualificado" é ordem 4 no CV. A tela manda quando houver. */
const ORDEM_BLINDADA_PADRAO = 4;

/** Lista de situações do CV, com cache. Lança se o CV não responder. */
export async function getWorkflow({ force = false } = {}) {
    if (!force && cache && Date.now() - cache.em < CACHE_MS) return cache.lista;
    const r = await apiCv.get('/v1/cv/workflow/leads');
    const lista = Array.isArray(r?.data) ? r.data : [];
    if (!lista.length) throw new Error('CV devolveu workflow de leads vazio.');
    cache = { em: Date.now(), lista };
    return lista;
}

export function invalidarWorkflowCv() { cache = null; }

async function getOrdemBlindada() {
    try {
        const cfg = await MarketingConfigService.getConfig();
        if (cfg?.lead_return_ordem_blindada != null) return Number(cfg.lead_return_ordem_blindada);
    } catch { /* cai no padrão */ }
    return Number(process.env.CV_LEAD_ORDEM_BLINDADA) || ORDEM_BLINDADA_PADRAO;
}

const norm = v => String(v || '').trim().toLowerCase();

/**
 * Classifica uma situação do CV em faixa.
 *
 * ARMADILHA MEDIDA (25/08/2026): o `situacao_id` do espelho `leads` NÃO é
 * confiável para lead Descartado — ele guarda o id da etapa ANTERIOR ao
 * descarte. São 11.833 dos 19.967 descartados com id 4 (Em Atendimento), 5 (Com
 * Reserva), 15, 7, 16... Classificar por id colocaria lead descartado na faixa
 * blindada e travaria justamente quem a gente quer resgatar. Os NOMES batem 100%
 * com o workflow do CV (as 12 situações, sem sobra), então o nome manda e o id
 * é só desempate.
 *
 * Nunca lança: falha de leitura do CV vira blindado.
 *
 * @param {number|string|{id?:number,nome?:string,situacao_id?:number,situacao_nome?:string}} entrada
 * @returns {Promise<{id:?number,nome:?string,ordem:?number,flags:?object,conhecida:boolean,faixa:string,divergente:boolean}>}
 */
export async function classifySituacao(entrada) {
    const alvo = (entrada && typeof entrada === 'object')
        ? { id: entrada.id ?? entrada.situacao_id ?? null, nome: entrada.nome ?? entrada.situacao_nome ?? null }
        : { id: entrada ?? null, nome: null };

    const desconhecida = {
        id: alvo.id != null ? Number(alvo.id) : null,
        nome: alvo.nome || null,
        ordem: null, flags: null, conhecida: false, divergente: false, faixa: FAIXA.BLINDADO,
    };

    let lista;
    try {
        lista = await getWorkflow();
    } catch (err) {
        console.warn(`[cv-workflow] leitura falhou (${err.message}) — situação tratada como blindada.`);
        return desconhecida;
    }

    const porNome = alvo.nome ? lista.find(x => norm(x.nome) === norm(alvo.nome)) : null;
    const porId = alvo.id != null ? lista.find(x => Number(x.idsituacao) === Number(alvo.id)) : null;
    const s = porNome || porId;
    if (!s) return desconhecida;

    const flags = s.flags || {};
    const ordem = Number(s.ordem);
    const ordemBlindada = await getOrdemBlindada();

    // Cancelada primeiro: Descartado tem ordem 9, que passaria pelo corte.
    const faixa = flags.cancelada === 'S'
        ? FAIXA.FRIO
        : (ordem >= ordemBlindada ? FAIXA.BLINDADO : FAIXA.MORNO);

    return {
        id: Number(s.idsituacao),
        nome: s.nome,
        ordem,
        flags,
        conhecida: true,
        // Nome e id apontando para situações diferentes é o sintoma acima.
        divergente: !!(porNome && porId && porNome !== porId),
        faixa,
    };
}

/** A situação com flag "Início" — para onde o lead volta quando é devolvido à fila. */
export async function situacaoInicio() {
    const lista = await getWorkflow();
    const s = lista.find(x => (x.flags || {}).inicio === 'S');
    if (!s) throw new Error('O CV não tem situação com flag "Início" ativa.');
    return { id: Number(s.idsituacao), nome: s.nome };
}

export default { getWorkflow, classifySituacao, situacaoInicio, invalidarWorkflowCv, FAIXA };

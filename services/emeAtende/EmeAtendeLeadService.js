// services/emeAtende/EmeAtendeLeadService.js
//
// Ponte entre o que a IA ouviu e o que o CRM registra.
//
// A IA chama as ferramentas com o que o lead DECLAROU; aqui os dados são
// higienizados (só valores do vocabulário conhecido entram), gravados e os
// derivados - score, temperatura, chance, política de recontato - recalculados
// pelo emeAtendeLeadScoring. Nenhum julgamento vem do modelo.

import db from '../../models/sequelize/index.js';
import Scoring from './emeAtendeLeadScoring.js';
import EmeAtendeMessenger from './EmeAtendeMessenger.js';

/** Mantém só chaves conhecidas e valores dentro do vocabulário. */
function sanitizar(dados = {}) {
    const enums = {
        momento_compra: Scoring.MOMENTO_COMPRA,
        finalidade: Scoring.FINALIDADE,
        aprovacao_credito: Scoring.APROVACAO_CREDITO,
        restricao_nome: Scoring.SIM_NAO,
        possui_imovel: Scoring.SIM_NAO,
        entrada_disponivel: Scoring.SIM_NAO,
        usa_fgts: Scoring.SIM_NAO,
    };
    const limpo = {};
    for (const [k, valores] of Object.entries(enums)) {
        const v = dados[k];
        if (v && valores.includes(v) && v !== 'nao_informado') limpo[k] = v;
    }
    // Renda é número declarado, não faixa: faixa do programa muda de ano em ano,
    // e guardar o número mantém o histórico utilizável quando ela mudar.
    const renda = Number(dados.renda_declarada);
    if (Number.isFinite(renda) && renda > 0 && renda < 1000000) limpo.renda_declarada = Math.round(renda);
    if (dados.objecao_principal) limpo.objecao_principal = String(dados.objecao_principal).slice(0, 60);
    if (dados.observacao) limpo.observacao = String(dados.observacao).slice(0, 400);
    return limpo;
}

/** Sinais de comportamento contam para o score: o que a pessoa FEZ. */
async function coletarSinais(conversation, extra = {}) {
    const mensagensLead = await db.EmeAtendeMessage.count({
        where: { conversation_id: conversation.id, direction: 'in' },
    }).catch(() => 0);
    const midias = await db.EmeAtendeMessage.count({
        where: { conversation_id: conversation.id, direction: 'out', type: ['image', 'document'] },
    }).catch(() => 0);
    return { mensagens_lead: mensagensLead, pediu_material: midias > 0, ...extra };
}

/**
 * Registra (ou completa) a qualificação. Chamada quantas vezes a conversa
 * revelar algo novo - o merge é incremental, então "descobri que ele tem FGTS"
 * três mensagens depois não apaga o que já se sabia.
 */
async function registrarQualificacao({ lead, conversation, resumo, dados = {}, interesseVisita = false }) {
    if (!lead) return { ok: false, error: 'sem lead' };

    const novos = sanitizar(dados);
    const qualificacao = { ...(lead.qualificacao || {}), ...novos };
    const sinais = await coletarSinais(conversation, { pediu_visita: interesseVisita });

    const estagio = Scoring.avancarEstagio(lead.estagio, interesseVisita ? 'visita' : 'qualificado');
    const parcial = { ...lead.toJSON(), qualificacao, estagio, ultima_interacao_em: new Date() };
    const { score, temperatura, chance } = Scoring.recalcular(parcial, sinais);

    await lead.update({
        qualificacao,
        estagio,
        score,
        temperatura,
        chance_venda: chance,
        status: 'qualified',
        qualified_summary: resumo || lead.qualified_summary,
        qualificado_em: lead.qualificado_em || new Date(),
        ultima_interacao_em: new Date(),
    });

    await EmeAtendeMessenger.logEvent(lead.id, conversation?.id, 'lead_qualificado', {
        resumo, campos: Object.keys(novos), score, temperatura, chance, estagio,
    });
    return { ok: true, score, temperatura, chance, estagio, campos: Object.keys(novos) };
}

/**
 * Registra a perda com motivo do vocabulário - é o motivo que decide se e
 * quando o lead volta a ser abordado.
 */
async function registrarPerda({ lead, conversation, motivo, observacao = null }) {
    if (!lead) return { ok: false, error: 'sem lead' };
    const chave = Scoring.MOTIVOS_PERDA[motivo] ? motivo : 'outro';
    const { reconversao, recontatar_em } = Scoring.politicaRecontato(chave);

    const qualificacao = { ...(lead.qualificacao || {}) };
    if (observacao) qualificacao.observacao = String(observacao).slice(0, 400);

    const optOut = chave === 'opt_out';
    await lead.update({
        qualificacao,
        estagio: optOut ? 'opt_out' : 'perdido',
        motivo_perda: chave,
        reconversao,
        recontatar_em,
        chance_venda: 'nula',
        temperatura: 'gelado',
        status: optOut ? 'opted_out' : 'closed',
        perdido_em: new Date(),
        ultima_interacao_em: new Date(),
    });

    await EmeAtendeMessenger.logEvent(lead.id, conversation?.id, 'lead_perdido', {
        motivo: chave, rotulo: Scoring.MOTIVOS_PERDA[chave].rotulo, reconversao, recontatar_em,
    });
    return { ok: true, motivo: chave, reconversao, recontatar_em };
}

/** Toque leve a cada mensagem do lead: mantém estágio e temperatura vivos. */
async function registrarInteracao({ lead, conversation }) {
    if (!lead) return;
    try {
        const estagio = Scoring.avancarEstagio(lead.estagio, 'engajado');
        const sinais = await coletarSinais(conversation);
        const parcial = { ...lead.toJSON(), estagio, ultima_interacao_em: new Date() };
        const { score, temperatura, chance } = Scoring.recalcular(parcial, sinais);
        await lead.update({
            estagio, score, temperatura, chance_venda: chance, ultima_interacao_em: new Date(),
            status: ['received', 'opened'].includes(lead.status) ? 'engaged' : lead.status,
        });
    } catch (err) {
        // Métrica não pode derrubar atendimento.
        console.warn('[eme-atende/lead] registrarInteracao:', err?.message);
    }
}

export default { registrarQualificacao, registrarPerda, registrarInteracao, sanitizar };

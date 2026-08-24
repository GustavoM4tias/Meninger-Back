// services/emeAtende/EmeAtendeInteresseService.js
//
// Troca do empreendimento PRINCIPAL de um lead que já está conversando.
//
// Situação real: a pessoa está falando do empreendimento A e se cadastra numa
// campanha do B. Antes disso existir, o intake sobrescrevia o campo e a Eme
// seguia falando de A com o cadastro dizendo B - ninguém percebia.
//
// ── As três garantias ────────────────────────────────────────────────────────
// 1. SÓ TROCA PARA O QUE EXISTE. O nome que chega da campanha é conferido
//    contra os fluxos ativos (nome do fluxo, nome e slug do empreendimento no
//    site). Não casou? não troca nada: acumula como interesse não reconhecido e
//    registra o evento. Melhor um lead com histórico do que um cadastro
//    apontando pra empreendimento que não existe.
// 2. A CONVERSA CONTINUA, o assunto é que muda. Mesmo thread, mesmo histórico,
//    novo fluxo - é o "não sobrepor 100%": o lead não recomeça do zero.
// 3. NADA SE PERDE. O anterior vai pra payload.interesses com data, e vira o
//    aviso no prompt de que ele já perguntou de outro empreendimento.

import db from '../../models/sequelize/index.js';
import EmeAtendeFlowService from './EmeAtendeFlowService.js';
import EmeAtendeMessenger from './EmeAtendeMessenger.js';

/** Normaliza para comparar nome de empreendimento sem depender de acento/caixa. */
function chave(texto) {
    return String(texto || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * O empreendimento existe? Devolve o fluxo dele.
 *
 * Casa por nome do fluxo, nome do empreendimento no snapshot do site e slug -
 * a campanha manda o nome escrito por gente, e ele nunca vem igual ao cadastro.
 * Aceita também correspondência parcial ("Anjos" → "Residencial dos Anjos"),
 * mas só quando UM fluxo casa: dois candidatos viram indefinição, e indefinição
 * aqui significaria mandar o lead pro empreendimento errado.
 */
export async function resolverFluxo(empreendimento, cvId = null) {
    // Identidade ganha do texto: o fluxo aponta pro mesmo id do cadastro que a
    // campanha usa, então quando ele vem não há o que interpretar.
    if (cvId) {
        const porId = await db.EmeAtendeFlow.findOne({ where: { active: true, cv_enterprise_id: cvId } });
        if (porId) return porId;
    }
    const alvo = chave(empreendimento);
    if (!alvo) return null;

    const fluxos = await db.EmeAtendeFlow.findAll({ where: { active: true } });
    const candidatos = fluxos.filter(f => !f.is_default).map(f => ({
        fluxo: f,
        nomes: [f.name, f.site_snapshot?.nome, f.site_slug].filter(Boolean).map(chave),
    }));

    const exato = candidatos.find(c => c.nomes.includes(alvo));
    if (exato) return exato.fluxo;

    const parciais = candidatos.filter(c =>
        c.nomes.some(n => n && (n.includes(alvo) || alvo.includes(n))));
    return parciais.length === 1 ? parciais[0].fluxo : null;
}

/**
 * Troca o empreendimento principal do lead e vira o assunto da conversa aberta.
 *
 * @param {object} p.lead
 * @param {object} p.conversation conversa ABERTA (a que muda de assunto)
 * @param {string} p.empreendimento nome vindo da campanha ou dito pelo lead
 * @param {string} p.origem 'campanha' | 'lead' - só pro log
 * @returns {Promise<{trocou: boolean, motivo?: string, fluxo?: object, anterior?: string}>}
 */
export async function trocarPrincipal({ lead, conversation, empreendimento, cvId = null, origem = 'campanha' }) {
    if (!lead || !empreendimento) return { trocou: false, motivo: 'sem dados' };

    const anterior = lead.empreendimento || null;
    if (chave(anterior) === chave(empreendimento)) return { trocou: false, motivo: 'mesmo empreendimento' };

    const fluxo = await resolverFluxo(empreendimento, cvId);
    if (!fluxo) {
        // Não reconhecido: registra e NÃO troca. Guardar um empreendimento que
        // não existe faria a Eme atender sobre o nada.
        const payload = { ...(lead.payload || {}) };
        payload.interesses_nao_reconhecidos = [
            ...(payload.interesses_nao_reconhecidos || []),
            { empreendimento, em: new Date().toISOString(), origem },
        ];
        await lead.update({ payload });
        await EmeAtendeMessenger.logEvent(lead.id, conversation?.id, 'interesse_nao_reconhecido',
            { empreendimento, origem });
        console.warn(`[eme-atende/interesse] "${empreendimento}" não casou com fluxo nenhum - principal mantido.`);
        return { trocou: false, motivo: 'empreendimento não reconhecido' };
    }

    // Histórico: o anterior entra na lista antes de ser substituído.
    const payload = { ...(lead.payload || {}) };
    const interesses = Array.isArray(payload.interesses) ? [...payload.interesses] : [];
    for (const nome of [anterior, fluxo.site_snapshot?.nome || fluxo.name]) {
        if (nome && !interesses.some(i => chave(i.empreendimento) === chave(nome))) {
            interesses.push({ empreendimento: nome, em: new Date().toISOString() });
        }
    }
    payload.interesses = interesses;
    payload.empreendimento_anterior = anterior;

    const nomeNovo = fluxo.site_snapshot?.nome || fluxo.name;
    await lead.update({
        empreendimento: nomeNovo,
        cv_enterprise_id: fluxo.cv_enterprise_id || lead.cv_enterprise_id,
        flow_id: fluxo.id,
        payload,
    });
    if (conversation) await conversation.update({ flow_id: fluxo.id });

    await EmeAtendeMessenger.logEvent(lead.id, conversation?.id, 'interesse_principal_trocado',
        { de: anterior, para: nomeNovo, origem, fluxo: fluxo.name });
    console.log(`[eme-atende/interesse] lead ${lead.id}: ${anterior || '(sem)'} → ${nomeNovo} (${origem})`);

    return { trocou: true, fluxo, anterior, nome: nomeNovo };
}

export default { resolverFluxo, trocarPrincipal, chave };

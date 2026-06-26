// services/marketing/CvBacklogDispatchService.js
//
// Cutover: envia pro CV o "backlog" de leads que ficaram parados a partir de
// uma data de corte. Dois casos:
//   - status='historical' — espelho importado da Meta que nunca foi ao CV.
//     Resolve o vínculo (campanha-primeiro, via resolveLeadBinding) e dispara.
//   - status='routed'     — capturado AO VIVO mas segurado pelo modo sombra
//     (dry-run). Vínculo já resolvido; só re-dispara.
//
// O upsert é nativo do CV: o CvLeadDispatchService manda permitir_alteracao:true,
// então se a pessoa já existe no CRM o CV ATUALIZA em vez de duplicar.
//
// Segurança:
//   - preview=true só conta (não escreve nem dispara).
//   - disparo real é BLOQUEADO se o modo sombra ainda estiver ligado (seria
//     no-op: o dispatch só logaria sem enviar).
//   - processa em lote (limit) e é resumível — leads enviados saem do backlog,
//     então basta rodar de novo até zerar.

import { Op, fn, col } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { resolveLeadBinding } from './MetaLeadAdsService.js';
import { dispatchLead } from './CvLeadDispatchService.js';
import { recordLeadEvent } from './leadEventLog.js';
import MarketingConfigService from './MarketingConfigService.js';

const { InboundLead } = db;

// Corte padrão do cutover (todos os leads a partir de 01/06/2026 vão pro CV).
export const DEFAULT_CUTOFF = '2026-06-01';

// Status que entram no cutover.
const BACKLOG_STATUSES = ['historical', 'routed'];

function cutoffToDate(cutoff) {
    const d = new Date(`${cutoff}T00:00:00`);
    if (Number.isNaN(d.getTime())) throw new Error(`Data de corte inválida: ${cutoff}`);
    return d;
}

async function isShadowMode() {
    try {
        const cfg = await MarketingConfigService.getConfig();
        return cfg ? !!cfg.dry_run : (process.env.MARKETING_CAPTURE_DRY_RUN === 'true');
    } catch {
        return process.env.MARKETING_CAPTURE_DRY_RUN === 'true';
    }
}

/**
 * Resolve o vínculo de um lead histórico e, se resolvido, grava nele (em
 * memória — o save é feito pelo chamador). Retorna true se ficou roteável.
 */
async function applyBindingToHistorical(lead) {
    const platformOrigem = lead.cv_origem === 'IG' ? 'IG' : 'FB';
    const { binding, attribution, cvExtraFields, resolvedCampaignId } = await resolveLeadBinding({
        campaignId: lead.meta_campaign_id,
        adId: lead.meta_ad_id,
        formId: lead.meta_form_id,
        platformOrigem,
    });

    if (!binding.midia_slug || !binding.cv_origem) return false;

    const patch = {
        midia_slug: binding.midia_slug,
        cv_origem: binding.cv_origem,
        bound_empreendimentos: binding.bound_empreendimentos || lead.bound_empreendimentos || null,
        tags: binding.tags || lead.tags || null,
    };
    if (resolvedCampaignId && !lead.meta_campaign_id) patch.meta_campaign_id = resolvedCampaignId;
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
        if (!lead[k] && attribution[k]) patch[k] = attribution[k];
    }
    if (cvExtraFields) patch.extra_fields = { ...cvExtraFields, ...(lead.extra_fields || {}) };

    lead.set(patch);
    return true;
}

async function runDispatch(lead, summary) {
    try {
        const r = await dispatchLead(lead, { actor: 'cutover' });
        summary.dispatched += 1;
        if (r?.delivered) summary.delivered += 1;
        else if (r?.failed || r?.rejected) summary.failed += 1;
    } catch (e) {
        summary.failed += 1;
        summary.errors.push({ lead_id: lead.id, error: e.message });
    }
}

/**
 * Preview LEVE — só conta o backlog por status (sem resolver vínculo, sem
 * escrever). Dá o go/no-go: quantos históricos + quantos da fila de sombra.
 */
export async function previewBacklogSince({ cutoff = DEFAULT_CUTOFF } = {}) {
    const cutoffDate = cutoffToDate(cutoff);
    const shadow = await isShadowMode();

    const rows = await InboundLead.findAll({
        where: { status: { [Op.in]: BACKLOG_STATUSES }, created_at: { [Op.gte]: cutoffDate } },
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        group: ['status'],
        raw: true,
    });
    const byStatus = {};
    for (const r of rows) byStatus[r.status] = Number(r.count);
    const routed = byStatus.routed || 0;
    const historical = byStatus.historical || 0;

    return {
        cutoff,
        shadow_mode: shadow,
        routed_pending: routed,        // ao vivo segurado pelo dry-run
        historical_total: historical,  // espelho da Meta a enviar (se tiver vínculo)
        total: routed + historical,
        preview: true,
    };
}

/**
 * Dispara o backlog a partir do corte. Processa até `limit` leads e é resumível.
 *
 * @param {object}  opts
 * @param {string}  opts.cutoff  'YYYY-MM-DD' (default 2026-06-01)
 * @param {boolean} opts.preview se true, só classifica (não escreve nem dispara)
 * @param {number}  opts.limit   teto de leads por execução (resumível)
 */
export async function dispatchBacklogSince({ cutoff = DEFAULT_CUTOFF, preview = false, limit = 500 } = {}) {
    const cutoffDate = cutoffToDate(cutoff);
    const shadow = await isShadowMode();

    const summary = {
        cutoff,
        shadow_mode: shadow,
        scanned: 0,
        routed_pending: 0,
        historical_with_binding: 0,
        historical_no_binding: 0,
        no_contact: 0,
        dispatched: 0,
        delivered: 0,
        failed: 0,
        reached_limit: false,
        errors: [],
        preview,
    };

    // Disparo real exige modo sombra desligado — senão o dispatch só loga.
    if (!preview && shadow) {
        return {
            ...summary,
            blocked: true,
            reason: 'Modo sombra (dry-run) ainda está ligado. Desligue em Configurações antes de disparar, senão nada é enviado ao CV.',
        };
    }

    const leads = await InboundLead.findAll({
        where: { status: { [Op.in]: BACKLOG_STATUSES }, created_at: { [Op.gte]: cutoffDate } },
        order: [['created_at', 'ASC']],
        limit,
    });
    summary.scanned = leads.length;
    summary.reached_limit = leads.length >= limit;

    for (const lead of leads) {
        const hasContact = !!lead.email || !!lead.telefone;
        if (!hasContact) { summary.no_contact += 1; continue; }

        // Ao vivo segurado pelo dry-run: vínculo já resolvido, só re-dispara.
        if (lead.status === 'routed') {
            summary.routed_pending += 1;
            if (!preview) await runDispatch(lead, summary);
            continue;
        }

        // Histórico: resolve vínculo campanha-primeiro.
        let resolved = false;
        try {
            resolved = await applyBindingToHistorical(lead);
        } catch (e) {
            summary.errors.push({ lead_id: lead.id, error: e.message });
            continue;
        }
        if (!resolved) { summary.historical_no_binding += 1; continue; }
        summary.historical_with_binding += 1;
        if (preview) continue;

        // Promove histórico → routed (persiste o vínculo) e dispara.
        try {
            lead.status = 'routed';
            await lead.save();
            await recordLeadEvent({
                leadId: lead.id, type: 'routed', actor: 'cutover',
                statusFrom: 'historical', statusTo: 'routed',
                message: 'Cutover: histórico roteado para envio ao CV.',
                detail: { midia: lead.midia_slug, origem: lead.cv_origem, empreendimentos: lead.bound_empreendimentos },
            });
        } catch (e) {
            summary.errors.push({ lead_id: lead.id, error: e.message });
            continue;
        }
        await runDispatch(lead, summary);
    }

    return summary;
}

export default { DEFAULT_CUTOFF, previewBacklogSince, dispatchBacklogSince };

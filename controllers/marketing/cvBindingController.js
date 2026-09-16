// controllers/marketing/cvBindingController.js
//
// Central de Vínculos CV — read-only. Mostra se tudo que deveria chegar ao CV
// está chegando e aponta as campanhas/forms sem vínculo que estão vazando leads.

import CvBindingHealthService from '../../services/marketing/CvBindingHealthService.js';
import CvBacklogDispatchService from '../../services/marketing/CvBacklogDispatchService.js';
import MetaAccountBindingService from '../../services/marketing/MetaAccountBindingService.js';

/**
 * GET /marketing/cv-binding/overview
 *   ?since=YYYY-MM-DD&until=YYYY-MM-DD   (opcional — recorta o funil)
 *   ?cutoff=YYYY-MM-DD                    (opcional — corte do backlog/held)
 */
export async function overview(req, res) {
    try {
        const { since, until, cutoff } = req.query;
        const result = await CvBindingHealthService.getOverview({
            since: since || null,
            until: until || null,
            ...(cutoff ? { cutoff } : {}),
        });
        return res.json({ ok: true, ...result });
    } catch (err) {
        console.error(`❌ [cv-binding] overview: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

/** Aceita `campaign_id` (um) ou `campaign_ids` (lista); devolve lista de strings. */
function idList(one, many) {
    const out = [];
    if (Array.isArray(many)) out.push(...many);
    else if (many != null && many !== '') out.push(many);
    if (one != null && one !== '') out.push(one);
    return [...new Set(out.map(v => String(v).trim()).filter(Boolean))];
}

/**
 * POST /marketing/cv-binding/dispatch-recoverable
 * Envia ao CV os represados (held) que já têm vínculo resolvível.
 * Body: { preview?, limit?, concurrency?, cutoff?, campaign_id?/campaign_ids?, form_id?/form_ids? }
 * Sem campanha/form no corpo, envia TODOS os recuperáveis (comportamento antigo).
 */
export async function dispatchRecoverable(req, res) {
    try {
        const preview = req.body?.preview === true;
        const limit = Math.min(Math.max(Number(req.body?.limit) || 500, 1), 1000);
        const concurrency = Math.min(Math.max(Number(req.body?.concurrency) || 5, 1), 10);
        const cutoff = req.body?.cutoff || undefined;
        const campaignIds = idList(req.body?.campaign_id, req.body?.campaign_ids);
        const formIds = idList(req.body?.form_id, req.body?.form_ids);
        const result = await CvBacklogDispatchService.dispatchRecoverableHeld({
            preview, limit, concurrency,
            ...(cutoff ? { cutoff } : {}),
            ...(campaignIds.length ? { campaignIds } : {}),
            ...(formIds.length ? { formIds } : {}),
        });
        if (result?.blocked) return res.status(409).json({ ok: false, error: result.reason, ...result });
        return res.json({ ok: true, ...result });
    } catch (err) {
        console.error(`❌ [cv-binding] dispatchRecoverable: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

/**
 * POST /marketing/cv-binding/redispatch-delivered
 * Reenvia ao CV leads JÁ ENTREGUES cujo destino difere do vínculo atual
 * (correção pós-vínculo). Recorte por campanha/form é OBRIGATÓRIO.
 * Body: { preview?, limit?, concurrency?, campaign_id?/campaign_ids?, form_id?/form_ids? }
 */
export async function redispatchDelivered(req, res) {
    try {
        const preview = req.body?.preview === true;
        const limit = Math.min(Math.max(Number(req.body?.limit) || 500, 1), 1000);
        const concurrency = Math.min(Math.max(Number(req.body?.concurrency) || 5, 1), 10);
        const campaignIds = idList(req.body?.campaign_id, req.body?.campaign_ids);
        const formIds = idList(req.body?.form_id, req.body?.form_ids);
        const result = await CvBacklogDispatchService.redispatchDeliveredWithBinding({
            preview, limit, concurrency,
            ...(campaignIds.length ? { campaignIds } : {}),
            ...(formIds.length ? { formIds } : {}),
        });
        if (result?.blocked) return res.status(409).json({ ok: false, error: result.reason, ...result });
        return res.json({ ok: true, ...result });
    } catch (err) {
        console.error(`❌ [cv-binding] redispatchDelivered: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

// ── Vínculo padrão por conta de anúncio (2026-09-16) ────────────────────────
// A conta carrega o destino; a campanha herda. Ver MetaAccountBindingService.

/** GET /marketing/cv-binding/accounts */
export async function accounts(req, res) {
    try {
        const result = await MetaAccountBindingService.listAccounts();
        return res.json({ ok: true, ...result });
    } catch (err) {
        console.error(`❌ [cv-binding] accounts: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

/**
 * PUT /marketing/cv-binding/accounts/:accountId
 * body: { bound_empreendimentos: [int], midia_slug?, cv_origem?, tags?, mapping_active?, notes? }
 * Empreendimento vazio = conta fica sem vínculo padrão (as campanhas voltam a
 * depender do vínculo próprio).
 */
export async function setAccount(req, res) {
    try {
        const binding = await MetaAccountBindingService.setAccountBinding(
            req.params.accountId, req.body || {}, { userId: req.user?.id || null });
        return res.json({ ok: true, binding });
    } catch (err) {
        console.error(`❌ [cv-binding] setAccount: ${err.message}`);
        return res.status(400).json({ ok: false, error: err.message });
    }
}

export default { overview, dispatchRecoverable, redispatchDelivered, accounts, setAccount };

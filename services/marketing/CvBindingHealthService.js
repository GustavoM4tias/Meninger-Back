// services/marketing/CvBindingHealthService.js
//
// "Central de Vínculos CV" — responde a pergunta: tudo que DEVERIA chegar ao
// CV está chegando? E onde há vazamento por falta de vínculo?
//
// Contexto do fluxo (ver MetaLeadAdsService.resolveLeadBinding):
//   lead chega → resolve vínculo (campanha-primeiro, form-fallback)
//     • com vínculo (mapping_active && midia_slug) → routed → delivered
//     • SEM vínculo                                 → HELD (nunca vai ao CV no chute)
//   historical = espelho importado da Meta, aguardando disparo de backlog.
//
// Um "vazamento" = lead que existe mas não chega ao CV por falta de vínculo:
//   • held: represado explicitamente por falta de binding.
//   • campanha ativa sem vínculo: vai gerar held nos próximos leads (preventivo).
//
// Tudo read-only. A ação de vincular acontece na tela de campanhas
// (CampaignDetailModal) — aqui só apontamos o dedo pro que falta.

import { Op, fn, col, literal } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { previewBacklogSince, DEFAULT_CUTOFF } from './CvBacklogDispatchService.js';
import MarketingConfigService from './MarketingConfigService.js';

const { InboundLead, MetaCampaign, MetaLeadForm } = db;

const META_CHANNEL = 'meta_lead_ads';

/** Uma entidade (campanha/form) tem vínculo se mapping ativo E mídia definida. */
function isBound(entity) {
    return !!(entity && entity.mapping_active && entity.midia_slug);
}

/**
 * O fallback do formulário cobre campanha sem vínculo? Depende do escopo
 * configurado (meta_form_fallback_scope) — a MESMA regra do resolveLeadBinding,
 * senão a central diria "recuperável" pra lead que o disparo não resolve.
 */
async function formFallbackCoversCampaigns() {
    try {
        const cfg = await MarketingConfigService.getConfig();
        return (cfg?.meta_form_fallback_scope || 'no_campaign') === 'always';
    } catch {
        return false;   // mesmo fail-safe do resolveLeadBinding
    }
}

/**
 * Funil de entrega ao CV no período (por created_at). Conta os leads Meta por
 * status e deriva a taxa de cobertura = entregues ÷ (o que deveria chegar).
 */
async function deliveryFunnel({ since, until }) {
    const where = { channel: META_CHANNEL };
    if (since && until) {
        where.created_at = { [Op.between]: [new Date(`${since}T00:00:00`), new Date(`${until}T23:59:59.999`)] };
    }

    const rows = await InboundLead.findAll({
        where,
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        group: ['status'],
        raw: true,
    });

    const byStatus = {};
    for (const r of rows) byStatus[r.status] = Number(r.count) || 0;

    const delivered  = byStatus.delivered  || 0;
    const held       = byStatus.held       || 0;
    const historical = byStatus.historical || 0;
    const routed     = byStatus.routed     || 0;
    const dispatching = byStatus.dispatching || 0;
    const failed     = (byStatus.failed || 0) + (byStatus.rejected || 0);
    const spam       = byStatus.spam       || 0;
    const received   = byStatus.received   || 0;
    const validated  = byStatus.validated  || 0;

    // ── Cobertura = SÓ o fluxo AO VIVO ────────────────────────────────────────
    // `historical` é ESPELHO importado da Meta (a grande maioria já está no CV,
    // entrou pelo RD Station antes do cutover). Contar esses como "não entregue"
    // derrubava a cobertura pra um número irreal. Então historical fica FORA da
    // cobertura — é backlog/contexto, mostrado à parte. Spam também é excluído
    // (descarte proposital).
    const livePending = routed + dispatching + received + validated;
    const liveTotal   = delivered + held + failed + livePending;   // o que passou pelo nosso fluxo
    const coverage = liveTotal > 0 ? +((delivered / liveTotal) * 100).toFixed(1) : null;

    return {
        delivered, held, historical, routed, dispatching, failed, spam,
        pending: livePending,      // fluxo ao vivo aguardando roteamento/disparo
        live_total: liveTotal,
        coverage_pct: coverage,    // % do fluxo AO VIVO que chegou ao CV (exclui espelho histórico)
        by_status: byStatus,
    };
}

/**
 * Leads HELD agrupados por campanha — o vazamento concreto. Para cada campanha,
 * diz se ela JÁ tem vínculo agora (held recuperável: é só rotear) ou não
 * (precisa vincular primeiro).
 */
async function heldByCampaign({ cutoff }) {
    const cutoffDate = new Date(`${cutoff}T00:00:00`);

    const grouped = await InboundLead.findAll({
        where: {
            channel: META_CHANNEL,
            status: 'held',
            created_at: { [Op.gte]: cutoffDate },
        },
        attributes: [
            'meta_campaign_id',
            'meta_form_id',
            [fn('COUNT', col('id')), 'count'],
            [fn('MAX', col('created_at')), 'last_at'],
        ],
        group: ['meta_campaign_id', 'meta_form_id'],
        raw: true,
    });

    // Consolida por campanha (um campaign_id pode aparecer com forms diferentes).
    const byCampaign = new Map();   // campaign_id → { count, last_at, form_ids:Set, byForm:Map }
    let heldNoCampaign = 0;
    const formOnly = new Map();      // form_id → count  (held sem campaign_id)
    const allFormIds = new Set();    // todo form citado (com ou sem campanha)

    for (const g of grouped) {
        const cid = g.meta_campaign_id ? String(g.meta_campaign_id) : null;
        const fid = g.meta_form_id ? String(g.meta_form_id) : null;
        const count = Number(g.count) || 0;
        if (fid) allFormIds.add(fid);
        if (cid) {
            const cur = byCampaign.get(cid) || { count: 0, last_at: null, form_ids: new Set(), byForm: new Map() };
            cur.count += count;
            if (!cur.last_at || g.last_at > cur.last_at) cur.last_at = g.last_at;
            if (fid) {
                cur.form_ids.add(fid);
                cur.byForm.set(fid, (cur.byForm.get(fid) || 0) + count);
            }
            byCampaign.set(cid, cur);
        } else {
            heldNoCampaign += count;
            if (fid) formOnly.set(fid, (formOnly.get(fid) || 0) + count);
        }
    }

    // Enxerta metadados + status de vínculo de campanhas E forms.
    // Os forms entram AQUI (não só os sem campanha) porque o resolveLeadBinding
    // cai no mapping do form quando a campanha não tem vínculo — sem isso a conta
    // dava lead "em risco" que o disparo recuperaria numa boa.
    const campIds = [...byCampaign.keys()];
    const campsById = new Map();
    if (campIds.length) {
        const camps = await MetaCampaign.findAll({ where: { id: { [Op.in]: campIds } } });
        for (const c of camps) campsById.set(String(c.id), c.get({ plain: true }));
    }

    const formsById = new Map();
    if (allFormIds.size) {
        const rows = await MetaLeadForm.findAll({ where: { id: { [Op.in]: [...allFormIds] } } });
        for (const f of rows) formsById.set(String(f.id), f.get({ plain: true }));
    }

    const fallbackCovers = await formFallbackCoversCampaigns();

    const campaigns = campIds.map(cid => {
        const agg = byCampaign.get(cid);
        const camp = campsById.get(cid) || null;
        const bound = isBound(camp);
        // Recuperável hoje = campanha vinculada (tudo) OU form do lead vinculado —
        // este último só quando o escopo permite o form cobrir campanha.
        const resolvable = bound
            ? agg.count
            : (fallbackCovers
                ? [...agg.byForm.entries()].reduce((sum, [fid, n]) => sum + (isBound(formsById.get(fid)) ? n : 0), 0)
                : 0);
        return {
            campaign_id: cid,
            name: camp?.name || null,
            account_name: camp?.account_name || null,
            effective_status: camp?.effective_status || camp?.status || null,
            not_synced: !camp,                       // held aponta pra campanha fora do cache
            is_bound: bound,                         // já tem vínculo? held é só rotear
            midia_slug: camp?.midia_slug || null,
            mapping_active: camp?.mapping_active ?? null,
            held_count: agg.count,
            resolvable_count: resolvable,            // sai HOJE se disparar
            blocked_count: agg.count - resolvable,   // ainda preso por falta de vínculo
            resolvable_via_form: !bound && resolvable > 0,
            last_held_at: agg.last_at,
            form_ids: [...agg.form_ids],
        };
    }).sort((a, b) => b.held_count - a.held_count);

    // Forms held-sem-campanha (o vínculo do form é o único caminho deles).
    const formIds = [...formOnly.keys()];
    const forms = formIds.map(fid => {
        const form = formsById.get(fid) || null;
        return {
            form_id: fid,
            name: form?.name || null,
            page_name: form?.page_name || null,
            not_synced: !form,
            is_bound: isBound(form),
            midia_slug: form?.midia_slug || null,
            held_count: formOnly.get(fid) || 0,
        };
    }).sort((a, b) => b.held_count - a.held_count);

    return {
        campaigns,                       // campanhas com leads represados
        forms,                           // forms (sem campanha) com leads represados
        held_no_campaign: heldNoCampaign,
        unbound_campaigns: campaigns.filter(c => c.blocked_count > 0).length,
        recoverable_campaigns: campaigns.filter(c => c.resolvable_count > 0).length,
    };
}

/**
 * Campanhas ATIVAS sem vínculo (preventivo): mesmo sem leads represados ainda,
 * vão mandar os próximos leads pro held. Foca em objetivos de geração de lead.
 */
async function activeUnboundCampaigns() {
    const LEAD_OBJECTIVES = ['LEAD_GENERATION', 'OUTCOME_LEADS'];
    const rows = await MetaCampaign.findAll({
        where: {
            archived: false,
            effective_status: { [Op.iLike]: 'ACTIVE%' },
            objective: { [Op.in]: LEAD_OBJECTIVES },
            [Op.or]: [
                { midia_slug: null },
                { mapping_active: false },
            ],
        },
        attributes: [
            'id', 'name', 'account_name', 'effective_status', 'objective',
            'midia_slug', 'mapping_active', 'start_time',
        ],
        order: [['start_time', 'DESC']],
    });
    return rows.map(r => {
        const p = r.get({ plain: true });
        return {
            campaign_id: String(p.id),
            name: p.name,
            account_name: p.account_name,
            effective_status: p.effective_status,
            objective: p.objective,
            reason: !p.midia_slug ? 'sem_midia' : 'mapping_desativado',
            start_time: p.start_time,
        };
    });
}

/**
 * Campanhas SEM vínculo próprio cujos leads saíram (ou estão saindo) pelo
 * vínculo do FORMULÁRIO. Não é held — o lead FOI entregue — e por isso era
 * invisível na central: tudo verde enquanto o destino podia estar errado
 * (form de um produto cobrindo campanha de outro; incidente ago/2026,
 * Esmeralda×Três Marias). Mostra o destino que o form aplicou para o admin
 * bater com o produto real da campanha.
 */
async function fallbackDeliveries({ days = 30 } = {}) {
    const [rows] = await db.sequelize.query(`
        SELECT mc.id                     AS campaign_id,
               mc.name                   AS name,
               mc.account_name           AS account_name,
               mc.effective_status       AS effective_status,
               mlf.id                    AS form_id,
               mlf.name                  AS form_name,
               mlf.midia_slug            AS form_midia,
               mlf.bound_empreendimentos AS form_emps,
               COUNT(il.id)::int         AS lead_count,
               MAX(il.created_at)        AS last_at
          FROM inbound_leads il
          JOIN meta_campaigns mc   ON mc.id = il.meta_campaign_id
          JOIN meta_lead_forms mlf ON mlf.id = il.meta_form_id
         WHERE il.channel = :channel
           AND il.status IN ('delivered', 'routed', 'dispatching')
           AND il.created_at >= now() - (:days * interval '1 day')
           AND (mc.midia_slug IS NULL OR mc.mapping_active = false)
           AND mlf.midia_slug IS NOT NULL AND mlf.mapping_active = true
         GROUP BY mc.id, mc.name, mc.account_name, mc.effective_status,
                  mlf.id, mlf.name, mlf.midia_slug, mlf.bound_empreendimentos
         ORDER BY MAX(il.created_at) DESC`,
        { replacements: { channel: META_CHANNEL, days } });

    // Enxerta o NOME do empreendimento — "[39]" não conta a história; "TRES
    // MARIAS - IBITINGA" numa campanha da conta Esmeralda conta.
    const ids = new Set();
    for (const r of rows) {
        const emps = Array.isArray(r.form_emps) ? r.form_emps : [];
        for (const id of emps) ids.add(Number(id));
    }
    const namesById = new Map();
    if (ids.size && db.CvEnterprise) {
        const ents = await db.CvEnterprise.findAll({
            where: { idempreendimento: { [Op.in]: [...ids] } },
            attributes: ['idempreendimento', 'nome'],
            raw: true,
        });
        for (const e of ents) namesById.set(Number(e.idempreendimento), e.nome);
    }
    return rows.map(r => ({
        ...r,
        campaign_id: String(r.campaign_id),
        form_emp_names: (Array.isArray(r.form_emps) ? r.form_emps : [])
            .map(id => namesById.get(Number(id)) || `#${id}`),
    }));
}

/**
 * Overview completo da central. Período recorta o funil; o backlog/held usa o
 * cutoff (default do cutover) pra ignorar leads de teste antigos.
 */
export async function getOverview({ since = null, until = null, cutoff = DEFAULT_CUTOFF } = {}) {
    const [funnel, held, activeUnbound, backlog, fallbackInUse] = await Promise.all([
        deliveryFunnel({ since, until }),
        heldByCampaign({ cutoff }),
        activeUnboundCampaigns(),
        previewBacklogSince({ cutoff }).catch(() => null),
        fallbackDeliveries().catch(() => []),
    ]);

    // Represados recuperáveis = o que o disparo resolveria HOJE (vínculo da
    // campanha OU fallback do form). Um lead só é "em risco" se nem um nem outro.
    const leadsRecoverable = held.campaigns.reduce((s, c) => s + c.resolvable_count, 0)
        + held.forms.filter(f => f.is_bound).reduce((s, f) => s + f.held_count, 0);

    const leadsAtRisk = held.campaigns.reduce((s, c) => s + c.blocked_count, 0)
        + held.forms.filter(f => !f.is_bound).reduce((s, f) => s + f.held_count, 0);

    return {
        period: since && until ? { since, until } : null,
        cutoff,
        funnel,
        held,
        active_unbound_campaigns: activeUnbound,
        fallback_in_use: fallbackInUse,   // campanhas sem vínculo entregando pelo form (30d)
        backlog,                          // { routed_pending, historical_total, ... }
        summary: {
            fallback_campaigns: fallbackInUse.length,
            leads_at_risk: leadsAtRisk,               // held por falta de vínculo
            leads_recoverable: leadsRecoverable,      // held mas já vinculável
            unbound_campaigns_with_leads: held.campaigns.filter(c => c.blocked_count > 0).length,
            recoverable_campaigns_with_leads: held.campaigns.filter(c => c.resolvable_count > 0).length,
            active_unbound_campaigns: activeUnbound.length,
            coverage_pct: funnel.coverage_pct,
        },
    };
}

/**
 * Sinal para o alerta automático: existe vazamento que justifica notificar?
 * (campanhas sem vínculo acumulando leads represados). Usado pelo scheduler.
 */
export async function getAlertSignal({ cutoff = DEFAULT_CUTOFF } = {}) {
    const held = await heldByCampaign({ cutoff });
    const unbound = held.campaigns.filter(c => c.blocked_count > 0);
    const leadsAtRisk = unbound.reduce((s, c) => s + c.blocked_count, 0)
        + held.forms.filter(f => !f.is_bound).reduce((s, f) => s + f.held_count, 0);
    return {
        should_alert: unbound.length > 0 && leadsAtRisk > 0,
        unbound_count: unbound.length,
        leads_at_risk: leadsAtRisk,
        top: unbound.slice(0, 5).map(c => ({ name: c.name || c.campaign_id, held: c.blocked_count })),
    };
}

export default { getOverview, getAlertSignal };

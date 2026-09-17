// services/marketing/MetaAccountBindingService.js
//
// Vínculo padrão por CONTA de anúncio da Meta e a regra que decide o vínculo
// EFETIVO de uma campanha (2026-09-16).
//
// Antes o gatilho do roteamento era a mídia (texto livre) da campanha, e toda
// campanha nova nascia sem vínculo. Agora a âncora é o EMPREENDIMENTO:
//
//   1. campanha com `mapping_active = false`  → sem vínculo (lead vira held)
//   2. campanha marcada "fora do CV"          → { skip } (lead vira ignored)
//   3. campanha com empreendimento próprio     → vínculo da campanha
//   4. conta com empreendimento (e ativa)      → vínculo da conta (herdado)
//   5. conta marcada "fora do CV"             → { skip } (lead vira ignored)
//   6. campanha só com mídia (legado)          → vínculo da campanha, sem emp.
//   7. nada disso                              → sem vínculo (held)
//
// Mídia e origem: campanha → conta → padrão de Configurações. Assim vincular
// a conta uma vez basta, e a campanha só precisa de vínculo próprio quando é
// exceção (outro produto rodando na mesma conta).
//
// A lista de contas vem de meta_campaigns (é o que a Meta sincroniza); esta
// tabela guarda só a decisão. Todo lugar que pergunta "esta campanha tem
// vínculo?" (captura ao vivo, backlog, Central de Vínculos, alerta) passa por
// resolveForCampaign ou pelo fragmento SQL abaixo - regra num lugar só.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import MarketingConfigService from './MarketingConfigService.js';

const { MetaAdAccountBinding, MetaCampaign, CvLeadQueueBinding, CvLeadQueue, OrgEnterprise } = db;

const LEAD_OBJECTIVES = ['LEAD_GENERATION', 'OUTCOME_LEADS'];

// A tabela nasce aqui também, e não só no ensure do boot: o gate de schema
// pula a fase inteira quando o fingerprint não mudou ou com SKIP_DB_SYNC, e
// a primeira leitura da Central não pode quebrar por isso.
let _schemaEnsured = false;
export async function ensureSchema() {
    if (_schemaEnsured) return;
    try {
        await db.sequelize.query(`
            CREATE TABLE IF NOT EXISTS meta_ad_account_bindings (
                account_id            VARCHAR(40) PRIMARY KEY,
                account_name          VARCHAR(255),
                bound_empreendimentos JSONB,
                midia_slug            VARCHAR(60),
                cv_origem             VARCHAR(4),
                tags                  JSONB,
                mapping_active        BOOLEAN NOT NULL DEFAULT true,
                cv_skip               BOOLEAN NOT NULL DEFAULT false,
                notes                 TEXT,
                definido_por          INTEGER,
                created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )`);
        await db.sequelize.query(`ALTER TABLE meta_ad_account_bindings ADD COLUMN IF NOT EXISTS cv_skip BOOLEAN NOT NULL DEFAULT false`);
        await db.sequelize.query(`ALTER TABLE meta_campaigns ADD COLUMN IF NOT EXISTS cv_skip BOOLEAN DEFAULT false`);
        _schemaEnsured = true;
    } catch (err) {
        console.warn('[meta-account-binding] ensure da tabela falhou:', err.message);
    }
}

function hasEmp(v) {
    return Array.isArray(v) && v.length > 0;
}

function normalizeEmps(v) {
    if (!Array.isArray(v)) return [];
    return [...new Set(v.map(Number).filter(n => Number.isInteger(n) && n > 0))];
}

/** Mídia/origem padrão (Configurações). Fail-safe = o que 20 campanhas já usavam. */
export async function getDefaults() {
    try {
        const cfg = await MarketingConfigService.getConfig();
        return {
            midia_slug: cfg?.meta_default_midia_slug || 'Facebook Ads',
            cv_origem: cfg?.meta_default_cv_origem === 'IG' ? 'IG' : 'FB',
        };
    } catch {
        return { midia_slug: 'Facebook Ads', cv_origem: 'FB' };
    }
}

export async function getAccountBinding(accountId) {
    if (!accountId) return null;
    await ensureSchema();
    const row = await MetaAdAccountBinding.findByPk(String(accountId));
    return row ? row.get({ plain: true }) : null;
}

/**
 * Vínculo EFETIVO de uma campanha (regra no cabeçalho). `camp` é a linha de
 * meta_campaigns (instância ou plain). `account` pode vir pré-carregado para
 * não reler a conta a cada campanha numa listagem.
 *
 * @returns {null | { source:'campanha'|'conta', skip?:true, bound_empreendimentos, midia_slug, cv_origem, tags, account_id }}
 *   `skip: true` = fora do CV: o lead não é despachado nem cobrado como represado.
 */
export async function resolveForCampaign(camp, { account = undefined, defaults = undefined } = {}) {
    if (!camp) return null;
    const c = camp.get ? camp.get({ plain: true }) : camp;
    if (c.mapping_active === false) return null;
    if (c.cv_skip === true) return { source: 'campanha', skip: true, account_id: c.account_id, bound_empreendimentos: null, midia_slug: null, cv_origem: null, tags: null };

    const acc = account !== undefined ? account : await getAccountBinding(c.account_id);
    const accOk = !!(acc && acc.mapping_active !== false && hasEmp(acc.bound_empreendimentos));
    const accSkip = !!(acc && acc.mapping_active !== false && acc.cv_skip === true);
    const dft = defaults || await getDefaults();

    const midia  = c.midia_slug || (accOk ? acc.midia_slug : null) || dft.midia_slug;
    const origem = c.cv_origem  || (accOk ? acc.cv_origem  : null) || dft.cv_origem;

    if (hasEmp(c.bound_empreendimentos)) {
        return {
            source: 'campanha', account_id: c.account_id,
            bound_empreendimentos: normalizeEmps(c.bound_empreendimentos),
            midia_slug: midia, cv_origem: origem,
            tags: hasEmp(c.tags) ? c.tags : (accOk && hasEmp(acc.tags) ? acc.tags : null),
        };
    }
    if (accOk) {
        return {
            source: 'conta', account_id: c.account_id,
            bound_empreendimentos: normalizeEmps(acc.bound_empreendimentos),
            midia_slug: midia, cv_origem: origem,
            tags: hasEmp(c.tags) ? c.tags : (hasEmp(acc.tags) ? acc.tags : null),
        };
    }
    // Conta externa (sem fila no CV): o lead fica no Office como "Fora do CV".
    if (accSkip) {
        return { source: 'conta', skip: true, account_id: c.account_id, bound_empreendimentos: null, midia_slug: null, cv_origem: null, tags: null };
    }
    // Legado: campanha só com mídia (lead sai sem idempreendimento). Nenhuma
    // campanha está assim hoje, mas quem estiver continua funcionando.
    if (c.midia_slug) {
        return {
            source: 'campanha', account_id: c.account_id,
            bound_empreendimentos: null,
            midia_slug: c.midia_slug, cv_origem: origem,
            tags: hasEmp(c.tags) ? c.tags : null,
        };
    }
    return null;
}

/** Mesma regra, para várias campanhas de uma vez (Central, listagem). */
export async function resolveMany(camps) {
    const list = (camps || []).map(c => (c?.get ? c.get({ plain: true }) : c)).filter(Boolean);
    const ids = [...new Set(list.map(c => c.account_id).filter(Boolean))];
    await ensureSchema();
    const rows = ids.length ? await MetaAdAccountBinding.findAll({ where: { account_id: { [Op.in]: ids } } }) : [];
    const byAcc = new Map(rows.map(r => [r.account_id, r.get({ plain: true })]));
    const defaults = await getDefaults();
    const out = new Map();
    for (const c of list) {
        out.set(String(c.id), await resolveForCampaign(c, { account: byAcc.get(c.account_id) || null, defaults }));
    }
    return out;
}

// ── SQL ─────────────────────────────────────────────────────────────────────
// Para as consultas agregadas da Central, que precisam da mesma regra dentro
// do SQL. Exigem `meta_campaigns mc LEFT JOIN meta_ad_account_bindings ab ON
// ab.account_id = mc.account_id`.
export const ACCOUNT_JOIN_SQL = `LEFT JOIN meta_ad_account_bindings ab ON ab.account_id = mc.account_id`;

const EMPS_OK = (col) => `COALESCE(jsonb_typeof(${col}) = 'array' AND jsonb_array_length(${col}) > 0, false)`;

/** Empreendimentos efetivos (JSONB ou NULL). */
export const EFFECTIVE_EMPS_SQL = `
    CASE
      WHEN COALESCE(mc.mapping_active, true) = false THEN NULL
      WHEN ${EMPS_OK('mc.bound_empreendimentos')} THEN mc.bound_empreendimentos
      WHEN COALESCE(ab.mapping_active, false) = true AND ${EMPS_OK('ab.bound_empreendimentos')} THEN ab.bound_empreendimentos
      ELSE NULL
    END`;

/**
 * Booleano: a campanha está RESOLVIDA (vínculo próprio, herdado, só mídia
 * legado, ou marcada fora do CV). "Fora do CV" conta como resolvida porque
 * ninguém precisa vincular nada: é decisão, não pendência.
 */
export const EFFECTIVELY_BOUND_SQL = `
    (COALESCE(mc.mapping_active, true) = true AND (
        mc.midia_slug IS NOT NULL
        OR COALESCE(mc.cv_skip, false) = true
        OR ${EMPS_OK('mc.bound_empreendimentos')}
        OR (COALESCE(ab.mapping_active, false) = true AND (${EMPS_OK('ab.bound_empreendimentos')} OR COALESCE(ab.cv_skip, false) = true))
    ))`;

// ── Contas ──────────────────────────────────────────────────────────────────

/**
 * Todas as contas de anúncio conhecidas (das campanhas sincronizadas) com o
 * vínculo padrão, o que cada campanha faz com ele e a fila do CV do
 * empreendimento. É a tabela da aba Vínculos.
 */
export async function listAccounts() {
    await ensureSchema();
    const [accounts] = await db.sequelize.query(`
        SELECT mc.account_id,
               MAX(mc.account_name)                                            AS account_name,
               COUNT(*)::int                                                   AS campaigns_total,
               COUNT(*) FILTER (WHERE mc.effective_status ILIKE 'ACTIVE%' AND mc.archived = false)::int AS campaigns_active,
               COUNT(*) FILTER (WHERE mc.effective_status ILIKE 'ACTIVE%' AND mc.archived = false
                                  AND mc.objective IN (:leadObjectives))::int   AS lead_campaigns_active,
               COUNT(*) FILTER (WHERE ${EMPS_OK('mc.bound_empreendimentos')})::int AS campaigns_own_binding,
               COUNT(*) FILTER (WHERE mc.effective_status ILIKE 'ACTIVE%' AND mc.archived = false
                                  AND mc.objective IN (:leadObjectives)
                                  AND NOT ${EFFECTIVELY_BOUND_SQL})::int        AS lead_campaigns_unbound,
               MAX(mc.last_synced_at)                                          AS last_synced_at
          FROM meta_campaigns mc
          ${ACCOUNT_JOIN_SQL}
         GROUP BY mc.account_id
         ORDER BY lead_campaigns_active DESC, campaigns_active DESC, MAX(mc.account_name) ASC`,
        { replacements: { leadObjectives: LEAD_OBJECTIVES } });

    const ids = accounts.map(a => a.account_id);
    const [bindings, leads30, filaBindings, filas, enterprises, defaults] = await Promise.all([
        ids.length ? MetaAdAccountBinding.findAll({ where: { account_id: { [Op.in]: ids } } }) : [],
        ids.length ? db.sequelize.query(`
            SELECT mc.account_id, COUNT(*)::int AS leads_30d
              FROM inbound_leads il
              JOIN meta_campaigns mc ON mc.id = il.meta_campaign_id
             WHERE il.created_at >= now() - interval '30 days' AND il.status <> 'spam'
             GROUP BY mc.account_id`).then(r => r[0]) : [],
        CvLeadQueueBinding.findAll(),
        CvLeadQueue.findAll({ attributes: ['idfila', 'nome', 'presente_no_cv'] }),
        OrgEnterprise.findAll({ where: { cv_id: { [Op.ne]: null } }, attributes: ['cv_id', 'name', 'city'] }),
        getDefaults(),
    ]);

    const bindingByAcc = new Map(bindings.map(b => [b.account_id, b.get({ plain: true })]));
    const leadsByAcc = new Map(leads30.map(r => [r.account_id, Number(r.leads_30d) || 0]));
    const filaById = new Map(filas.map(f => [f.idfila, f]));
    const filaByEmp = new Map(filaBindings.map(b => [b.idempreendimento, b.idfila]));
    const empById = new Map(enterprises.map(e => [Number(e.cv_id), e]));

    // Praça da fila = cidades dos empreendimentos vinculados a ela (o CV não
    // expõe isso). Fila que atende outra praça e não a deste empreendimento é
    // divergente: foi assim que Ibitinga caiu na fila de Avaré.
    const cidadesDaFila = new Map();
    for (const b of filaBindings) {
        const cidade = empById.get(Number(b.idempreendimento))?.city;
        if (!b.idfila || !cidade) continue;
        if (!cidadesDaFila.has(b.idfila)) cidadesDaFila.set(b.idfila, new Set());
        cidadesDaFila.get(b.idfila).add(cidade);
    }

    const describeEmp = (id) => {
        const e = empById.get(Number(id));
        const idfila = filaByEmp.get(Number(id)) || null;
        const fila = idfila ? filaById.get(idfila) : null;
        const filaCidades = idfila ? [...(cidadesDaFila.get(idfila) || [])] : [];
        return {
            idempreendimento: Number(id),
            nome: e?.name || `#${id}`,
            cidade: e?.city || null,
            idfila,
            fila_nome: fila?.nome || null,
            fila_sumiu_do_cv: !!(idfila && fila && !fila.presente_no_cv),
            fila_cidades: filaCidades,
            fila_praca_divergente: !!(idfila && e?.city && filaCidades.length && !filaCidades.includes(e.city)),
        };
    };

    return {
        defaults,
        accounts: accounts.map(a => {
            const b = bindingByAcc.get(a.account_id) || null;
            const emps = b ? normalizeEmps(b.bound_empreendimentos) : [];
            const bound = !!(b && b.mapping_active !== false && emps.length);
            const foraDoCv = !!(b && b.mapping_active !== false && !emps.length && b.cv_skip === true);
            return {
                account_id: a.account_id,
                account_name: a.account_name,
                campaigns_total: a.campaigns_total,
                campaigns_active: a.campaigns_active,
                lead_campaigns_active: a.lead_campaigns_active,
                lead_campaigns_unbound: a.lead_campaigns_unbound,     // ativas de lead que NADA resolve hoje
                campaigns_own_binding: a.campaigns_own_binding,       // exceções (vínculo próprio)
                leads_30d: leadsByAcc.get(a.account_id) || 0,
                last_synced_at: a.last_synced_at,
                is_bound: bound,
                fora_do_cv: foraDoCv,                                 // conta externa: lead não vai ao CV
                cv_skip: b?.cv_skip === true,
                mapping_active: b ? b.mapping_active !== false : true,
                bound_empreendimentos: emps,
                empreendimentos: emps.map(describeEmp),
                midia_slug: b?.midia_slug || null,          // null = padrão
                cv_origem: b?.cv_origem || null,            // null = padrão
                tags: Array.isArray(b?.tags) ? b.tags : [],
                notes: b?.notes || null,
                updated_at: b?.updated_at || null,
            };
        }),
    };
}

/** Grava o vínculo padrão da conta. Empreendimento vazio = conta sem vínculo. */
export async function setAccountBinding(accountId, patch = {}, { userId = null } = {}) {
    const id = String(accountId || '').trim();
    if (!id) throw new Error('account_id obrigatório.');
    await ensureSchema();

    const camp = await MetaCampaign.findOne({ where: { account_id: id }, attributes: ['account_name'] });

    const row = {
        account_id: id,
        account_name: camp?.account_name || patch.account_name || null,
        definido_por: userId,
    };
    if (patch.bound_empreendimentos !== undefined) row.bound_empreendimentos = normalizeEmps(patch.bound_empreendimentos);
    if (patch.midia_slug !== undefined) row.midia_slug = String(patch.midia_slug || '').trim().slice(0, 60) || null;
    if (patch.cv_origem !== undefined) row.cv_origem = ['FB', 'IG'].includes(patch.cv_origem) ? patch.cv_origem : null;
    if (patch.tags !== undefined) {
        const tags = Array.isArray(patch.tags) ? patch.tags.map(t => String(t).trim()).filter(Boolean) : [];
        row.tags = tags.length ? tags : null;
    }
    if (patch.mapping_active !== undefined) row.mapping_active = patch.mapping_active !== false;
    if (patch.cv_skip !== undefined) row.cv_skip = patch.cv_skip === true;
    if (patch.notes !== undefined) row.notes = String(patch.notes || '').trim() || null;

    await MetaAdAccountBinding.upsert(row);
    const saved = await getAccountBinding(id);

    // Conta fora do CV: os leads que já estão represados nas campanhas dela
    // (sem vínculo próprio) saem de 'held' para 'ignored' na hora, senão a
    // Central continuaria cobrando. Desmarcar devolve para 'held'.
    if (patch.cv_skip !== undefined) {
        const camps = await MetaCampaign.findAll({ where: { account_id: id }, attributes: ['id', 'bound_empreendimentos', 'midia_slug', 'cv_skip'] });
        const ids = camps.filter(c => !hasEmp(c.bound_empreendimentos) && !c.midia_slug && !c.cv_skip).map(c => c.id);
        if (ids.length) await applySkipToHeldLeads({ campaignIds: ids, skip: saved?.cv_skip === true && saved?.mapping_active !== false, actor: userId ? `user:${userId}` : 'system' });
    }
    return saved;
}

/**
 * Move os leads represados das campanhas para "Fora do CV" (ou de volta).
 * held → ignored quando a conta/campanha é marcada externa; ignored → held
 * quando desmarcada. Cada lead ganha um evento, para a timeline contar.
 */
export async function applySkipToHeldLeads({ campaignIds = [], skip, actor = 'system' }) {
    const ids = (campaignIds || []).map(String).filter(Boolean);
    if (!ids.length) return 0;
    const { InboundLead } = db;
    const { recordLeadEvent } = await import('./leadEventLog.js');
    const from = skip ? 'held' : 'ignored';
    const to = skip ? 'ignored' : 'held';
    const leads = await InboundLead.findAll({ where: { status: from, meta_campaign_id: { [Op.in]: ids } }, attributes: ['id'] });
    if (!leads.length) return 0;
    await InboundLead.update({ status: to }, { where: { id: { [Op.in]: leads.map(l => l.id) } } });
    for (const l of leads) {
        await recordLeadEvent({
            leadId: l.id, type: skip ? 'ignored' : 'held', actor,
            statusFrom: from, statusTo: to,
            message: skip
                ? 'Conta/campanha marcada como fora do CV - o lead fica no Office e não vai ao CRM.'
                : 'Conta/campanha voltou a valer para o CV - lead aguarda vínculo de novo.',
        });
    }
    return leads.length;
}

/** Quantas campanhas ativas de lead nada resolve hoje - para o alerta e o badge. */
export async function countUnboundAccounts() {
    const { accounts } = await listAccounts();
    return accounts.filter(a => a.lead_campaigns_unbound > 0).length;
}

export default {
    ensureSchema, getDefaults, getAccountBinding, resolveForCampaign, resolveMany,
    listAccounts, setAccountBinding, countUnboundAccounts, applySkipToHeldLeads,
    ACCOUNT_JOIN_SQL, EFFECTIVE_EMPS_SQL, EFFECTIVELY_BOUND_SQL,
};

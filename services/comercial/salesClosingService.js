// services/comercial/salesClosingService.js
//
// Fechamento (consolidação) mensal de vendas do Faturamento.
//
// Desenho anti-divergência:
//   • Os NÚMEROS congelados (lines/totals) vêm do próprio dashboard no momento
//     do fechamento — mesmo motor de cálculo que o admin está vendo, zero
//     risco de reimplementação divergir.
//   • O servidor fotografa os INSUMOS (contratos do período campo a campo +
//     hash das regras de VGV/comissão/TR/ocultos). A vigilância diária
//     refotografa e compara: qualquer mudança vira uma divergência explicada
//     (qual contrato, qual campo, de X para Y, detectada quando) e notifica
//     os admins. O snapshot consolidado NUNCA muda sozinho — só por
//     reconsolidação explícita, que versiona a anterior.
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';

const { SalesClosing, SalesClosingDivergence, User } = db;

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function periodBounds(period) {
    const [y, m] = period.split('-').map(Number);
    const start = `${period}-01`;
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // último dia do mês
    return { start, end };
}

// Campos do contrato que participam do resultado do Faturamento. Qualquer
// mudança em um deles num mês consolidado é divergência.
const TRACKED_FIELDS = [
    'situation',
    'financial_institution_date',
    'cancellation_date',
    'enterprise_id',
    'enterprise_name',
    'company_id',
    'land_value',
    'conditions_hash',
    'customer_id',
    'customer_name',
    'unit_name'
];

// ── Fotografia dos insumos (server-side) ────────────────────────────────────
export async function buildInputsSnapshot(period) {
    const { start, end } = periodBounds(period);

    // Mesmo recorte da visão padrão do dashboard: Emitido + Cancelado com data
    // no período, regra do mesmo mês, sem empreendimentos ocultos.
    const contracts = await db.sequelize.query(`
        SELECT
            sc.id,
            sc.situation,
            sc.financial_institution_date::date::text AS financial_institution_date,
            sc.cancellation_date::date::text          AS cancellation_date,
            sc.enterprise_id,
            sc.enterprise_name,
            sc.company_id,
            sc.land_value::text                       AS land_value,
            md5(COALESCE(sc.payment_conditions::text, '')) AS conditions_hash,
            COALESCE(
                (SELECT NULLIF(c ->> 'id','')::bigint FROM jsonb_array_elements(sc.customers) c
                 WHERE (c ->> 'main')::boolean = true LIMIT 1),
                (SELECT NULLIF(c ->> 'id','')::bigint FROM jsonb_array_elements(sc.customers) c
                 ORDER BY (c ->> 'id')::int NULLS LAST LIMIT 1)
            )::text AS customer_id,
            COALESCE(
                (SELECT c ->> 'name' FROM jsonb_array_elements(sc.customers) c
                 WHERE (c ->> 'main')::boolean = true LIMIT 1),
                (SELECT c ->> 'name' FROM jsonb_array_elements(sc.customers) c LIMIT 1)
            ) AS customer_name,
            COALESCE(
                (SELECT u ->> 'name' FROM jsonb_array_elements(sc.units) u
                 WHERE (u ->> 'main')::boolean = true LIMIT 1),
                (SELECT u ->> 'name' FROM jsonb_array_elements(sc.units) u LIMIT 1)
            ) AS unit_name
        FROM contracts sc
        WHERE sc.financial_institution_date BETWEEN :start AND :end
          AND sc.situation IN ('Emitido', 'Cancelado')
          AND (
            sc.situation <> 'Cancelado'
            OR sc.cancellation_date IS NULL
            OR date_trunc('month', sc.cancellation_date) > date_trunc('month', sc.financial_institution_date)
          )
          AND NOT EXISTS (
            SELECT 1 FROM hidden_dashboard_enterprises h
            WHERE h.active = true AND h.enterprise_id = sc.enterprise_id
          )
        ORDER BY sc.id
    `, { replacements: { start, end }, type: db.Sequelize.QueryTypes.SELECT });

    const byId = {};
    for (const c of contracts) {
        const { id, ...fields } = c;
        byId[String(id)] = fields;
    }

    // Hash por tabela de regra: mudança de regra também explica número diferente.
    const RULE_TABLES = [
        'enterprise_value_rules',
        'stage_commission_rules',
        'tr_satellite_enterprises',
        'hidden_dashboard_enterprises',
        'enterprise_erp_links'
    ];
    const rules = {};
    for (const t of RULE_TABLES) {
        try {
            const [[row]] = await db.sequelize.query(
                `SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) AS hash, COUNT(*)::int AS count
                 FROM ${t} t`
            );
            rules[t] = { hash: row.hash, count: row.count };
        } catch {
            rules[t] = { hash: null, count: null };
        }
    }

    return { contracts: byId, rules, captured_at: new Date().toISOString() };
}

// ── Consolidação ────────────────────────────────────────────────────────────
export async function consolidate({ period, lines, totals, notes, user }) {
    if (!PERIOD_RE.test(String(period || ''))) throw new Error('Período inválido. Use YYYY-MM.');
    if (!Array.isArray(lines) || !lines.length) throw new Error('Fechamento sem linhas de venda.');
    if (!totals || typeof totals !== 'object') throw new Error('Fechamento sem totais.');

    const inputs = await buildInputsSnapshot(period);

    const existing = await SalesClosing.findOne({ where: { period } });
    if (!existing) {
        return SalesClosing.create({
            period,
            status: 'consolidado',
            version: 1,
            consolidated_at: new Date(),
            consolidated_by_id: user?.id ?? null,
            consolidated_by_name: user?.name ?? user?.email ?? null,
            totals,
            lines,
            inputs_snapshot: inputs,
            notes: notes || null
        });
    }

    // Reconsolidação: versiona a anterior e resolve as divergências abertas
    // (o novo snapshot já reflete o estado atual).
    //
    // ATENÇÃO: array NOVO, nunca push no `existing.history`. Mutar o array em
    // memória e devolver a mesma referência faz o Sequelize concluir que o
    // campo JSONB não mudou e o histórico é descartado em silêncio — foi assim
    // que a v1 de jan/2026 se perdeu. O changed() é o cinto de segurança.
    const history = [
        ...(Array.isArray(existing.history) ? existing.history : []),
        {
            version: existing.version,
            consolidated_at: existing.consolidated_at,
            consolidated_by_name: existing.consolidated_by_name,
            totals: existing.totals
        }
    ];
    existing.set({
        status: 'consolidado',
        version: existing.version + 1,
        consolidated_at: new Date(),
        consolidated_by_id: user?.id ?? null,
        consolidated_by_name: user?.name ?? user?.email ?? null,
        totals,
        lines,
        inputs_snapshot: inputs,
        history,
        notes: notes || existing.notes
    });
    existing.changed('history', true);
    await existing.save();

    // 'reconsolidated' e não 'resolved_by_reconsolidation': a coluna é
    // varchar(20) e o valor longo estourava (erro 22001) DEPOIS do save,
    // deixando a operação meio-feita.
    await SalesClosingDivergence.update(
        { status: 'reconsolidated', reviewed_at: new Date(), reviewed_by_id: user?.id ?? null },
        { where: { closing_id: existing.id, status: 'open' } }
    );

    return existing;
}

// ── Vigilância: refotografa e compara ───────────────────────────────────────
export async function checkDivergences({ notify = true } = {}) {
    const closings = await SalesClosing.findAll({ where: { status: 'consolidado' } });
    const created = [];

    for (const closing of closings) {
        const stored = closing.inputs_snapshot?.contracts || {};
        const storedRules = closing.inputs_snapshot?.rules || {};
        const current = await buildInputsSnapshot(closing.period);

        const divergences = [];

        // Contratos que entraram/saíram do recorte do mês
        for (const id of Object.keys(current.contracts)) {
            if (!stored[id]) {
                divergences.push({
                    kind: 'contract_added', contract_id: id, field: null,
                    old_value: null, new_value: null,
                    details: {
                        why: 'Contrato passou a entrar no recorte do mês (novo, data preenchida ou regra alterada).',
                        ...current.contracts[id]
                    }
                });
            }
        }
        for (const id of Object.keys(stored)) {
            if (!current.contracts[id]) {
                divergences.push({
                    kind: 'contract_removed', contract_id: id, field: null,
                    old_value: null, new_value: null,
                    details: {
                        why: 'Contrato saiu do recorte do mês (excluído no Sienge, data alterada, cancelado no mesmo mês ou empreendimento ocultado).',
                        ...stored[id]
                    }
                });
                continue;
            }
            // Campo a campo
            for (const f of TRACKED_FIELDS) {
                const oldV = stored[id]?.[f] ?? null;
                const newV = current.contracts[id]?.[f] ?? null;
                if (String(oldV ?? '') !== String(newV ?? '')) {
                    divergences.push({
                        kind: 'contract_changed', contract_id: id, field: f,
                        old_value: oldV != null ? String(oldV) : null,
                        new_value: newV != null ? String(newV) : null,
                        details: {
                            customer_name: current.contracts[id]?.customer_name ?? stored[id]?.customer_name ?? null,
                            unit_name: current.contracts[id]?.unit_name ?? stored[id]?.unit_name ?? null,
                            enterprise_name: current.contracts[id]?.enterprise_name ?? stored[id]?.enterprise_name ?? null
                        }
                    });
                }
            }
        }

        // Regras (VGV, comissão, TR, ocultos, vínculos)
        for (const t of Object.keys(current.rules)) {
            const oldH = storedRules[t]?.hash ?? null;
            const newH = current.rules[t]?.hash ?? null;
            if (oldH !== newH) {
                divergences.push({
                    kind: 'rules_changed', contract_id: null, field: t,
                    old_value: `${storedRules[t]?.count ?? '?'} regra(s)`,
                    new_value: `${current.rules[t]?.count ?? '?'} regra(s)`,
                    details: { why: 'Tabela de regras alterada depois do fechamento; os números congelados foram calculados com as regras antigas.' }
                });
            }
        }

        // Persiste só o que ainda não está aberto com a mesma assinatura
        for (const d of divergences) {
            const [row, isNew] = await SalesClosingDivergence.findOrCreate({
                where: {
                    closing_id: closing.id,
                    kind: d.kind,
                    contract_id: d.contract_id ?? null,
                    field: d.field ?? null,
                    new_value: d.new_value ?? null,
                    status: 'open'
                },
                defaults: {
                    period: closing.period,
                    old_value: d.old_value,
                    details: d.details,
                    detected_at: new Date()
                }
            });
            if (isNew) created.push(row);
        }
    }

    if (notify && created.length) {
        try {
            const admins = await User.findAll({ where: { role: 'admin' }, attributes: ['id'] });
            const byPeriod = [...new Set(created.map(d => d.period))].sort();
            await NotificationService.notify({
                type: NotificationType.SALES_CLOSING_DIVERGENCE,
                recipients: { users: admins.map(a => a.id) },
                title: 'Divergência em mês de vendas consolidado',
                body: `${created.length} mudança(s) detectada(s) nos dados de ${byPeriod.join(', ')} após o fechamento. O consolidado NÃO foi alterado — revise e reconsolide se fizer sentido.`,
                data: { periods: byPeriod, count: created.length },
                link: '/comercial/faturamento',
                importance: 8
            });
        } catch (err) {
            console.error('[salesClosing] Falha ao notificar divergências:', err.message);
        }
    }

    return { checked: closings.length, newDivergences: created.length };
}

// ── Consultas ───────────────────────────────────────────────────────────────
export async function listClosings() {
    const closings = await SalesClosing.findAll({
        order: [['period', 'DESC']],
        attributes: { exclude: ['lines', 'inputs_snapshot'] }
    });
    const open = await SalesClosingDivergence.findAll({
        where: { status: 'open' },
        attributes: ['period', [db.sequelize.fn('COUNT', '*'), 'count']],
        group: ['period'],
        raw: true
    });
    const openByPeriod = Object.fromEntries(open.map(o => [o.period, Number(o.count)]));
    return closings.map(c => ({ ...c.get({ plain: true }), open_divergences: openByPeriod[c.period] || 0 }));
}

export async function getClosing(period) {
    if (!PERIOD_RE.test(String(period || ''))) throw new Error('Período inválido. Use YYYY-MM.');
    const closing = await SalesClosing.findOne({ where: { period } });
    if (!closing) return null;
    const divergences = await SalesClosingDivergence.findAll({
        where: { closing_id: closing.id },
        order: [['status', 'ASC'], ['detected_at', 'DESC']]
    });
    return { ...closing.get({ plain: true }), divergences };
}

export async function reviewDivergence(id, user) {
    const row = await SalesClosingDivergence.findByPk(id);
    if (!row) throw new Error('Divergência não encontrada.');
    row.status = 'reviewed';
    row.reviewed_at = new Date();
    row.reviewed_by_id = user?.id ?? null;
    await row.save();
    return row;
}

export default { buildInputsSnapshot, consolidate, checkDivergences, listClosings, getClosing, reviewDivergence, PERIOD_RE, periodBounds };

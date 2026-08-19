// services/comercial/contractAdjustmentsService.js
//
// Máscara de ajustes contábeis sobre os contratos do Faturamento.
//
// FONTE ÚNICA: todo consumidor (dashboard, modal de detalhe, exportação,
// fechamento mensal, tools da Eme) aplica a máscara por aqui. Nada é gravado em
// `contracts` — essa tabela é espelho do backup do Sienge e é reescrita a cada
// sync, então qualquer correção feita nela sumiria sozinha.
//
// Divisão de trabalho:
//   • data da instituição financeira → SQL, porque é o recorte do período
//     (um contrato com data ajustada precisa ENTRAR/SAIR do mês no WHERE, não
//     adianta corrigir depois que a query já filtrou);
//   • séries (condições de pagamento) → JS, aplicado sobre o JSONB devolvido.
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';

export const ADJ_TYPES = ['FI_DATE', 'SERIE_ADD', 'SERIE_EDIT'];

// ── Data efetiva (SQL) ──────────────────────────────────────────────────────
// Subquery escalar em vez de JOIN: não altera a cardinalidade da consulta que
// a usa e pode entrar tanto no WHERE quanto no SELECT sem mais nenhum ajuste.
// O índice único parcial garante no máximo um FI_DATE ativo por contrato.
export function effectiveFiDateSql(alias = 'sc') {
    return `COALESCE(
        (SELECT (a.payload ->> 'financial_institution_date')::date
           FROM contract_adjustments a
          WHERE a.active = true
            AND a.status <> 'auto_resolved'
            AND a.type = 'FI_DATE'
            AND a.contract_id = ${alias}.id
          LIMIT 1),
        ${alias}.financial_institution_date
    )`;
}

// Filtro de período pela data EFETIVA, sem perder o índice.
//
// Escrever `WHERE <data efetiva> BETWEEN :start AND :end` seria mais curto, mas
// a expressão não é indexável: o Postgres passaria a avaliar a subquery linha a
// linha em `contracts` inteira e o idx_contracts_fid_situation morreria. As duas
// pernas abaixo dão o mesmo resultado mantendo o plano bom:
//   1. contrato SEM ajuste de data → filtro direto na coluna (usa o índice);
//   2. contrato COM ajuste de data → lista de ids vinda da tabela de ajustes,
//      que é pequena.
export function fiDateInRangeSql(alias = 'sc', startParam = 'start', endParam = 'end') {
    return `(
        (
            ${alias}.financial_institution_date BETWEEN :${startParam} AND :${endParam}
            AND NOT EXISTS (
                SELECT 1 FROM contract_adjustments a
                 WHERE a.active = true AND a.status <> 'auto_resolved'
                   AND a.type = 'FI_DATE' AND a.contract_id = ${alias}.id
            )
        )
        OR ${alias}.id IN (
            SELECT a.contract_id FROM contract_adjustments a
             WHERE a.active = true AND a.status <> 'auto_resolved' AND a.type = 'FI_DATE'
               AND (a.payload ->> 'financial_institution_date')::date
                   BETWEEN :${startParam} AND :${endParam}
        )
    )`;
}

// ── Carga dos ajustes de série ──────────────────────────────────────────────
// Devolve Map<string contract_id, ajuste[]>.
// `auto_resolved` fica de fora de propósito: o Sienge já traz o valor ajustado,
// aplicar a máscara daria no mesmo e o selo na tela seria ruído. `needs_review`
// CONTINUA sendo aplicado — a máscara não pode cair sozinha só porque a origem
// mudou; o admin é quem decide.
const APPLIED_STATUSES = ['active', 'needs_review'];

export async function loadSerieAdjustments(contractIds = []) {
    const ids = [...new Set(
        (contractIds || []).map((v) => String(v ?? '').trim()).filter(Boolean)
    )];
    const map = new Map();
    if (!ids.length) return map;

    const rows = await db.ContractAdjustment.findAll({
        where: {
            active: true,
            status: APPLIED_STATUSES,
            type: ['SERIE_ADD', 'SERIE_EDIT'],
            contract_id: ids
        },
        order: [['id', 'ASC']]
    });

    for (const row of rows) {
        const key = String(row.contract_id);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(row);
    }
    return map;
}

export async function loadAllAdjustments(contractIds = []) {
    const ids = [...new Set(
        (contractIds || []).map((v) => String(v ?? '').trim()).filter(Boolean)
    )];
    const map = new Map();
    if (!ids.length) return map;

    const rows = await db.ContractAdjustment.findAll({
        where: { active: true, status: APPLIED_STATUSES, contract_id: ids },
        order: [['id', 'ASC']]
    });
    for (const row of rows) {
        const key = String(row.contract_id);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(row);
    }
    return map;
}

// ── Aplicação da máscara de séries ──────────────────────────────────────────
// O JSONB do Sienge vem em camelCase (conditionTypeId, totalValue...). O front
// aceita as duas grafias (_normalizePaymentCondition), então gravamos a série
// ajustada em snake_case, que é o que a tela usa, e mantemos os campos que já
// existiam no original.
const SERIE_FIELDS = [
    'condition_type_id',
    'condition_type_name',
    'total_value',
    'installments_number',
    'base_date'
];

// Grafia camelCase equivalente, para apagar o campo antigo ao sobrescrever.
const CAMEL_OF = {
    condition_type_id: 'conditionTypeId',
    condition_type_name: 'conditionTypeName',
    total_value: 'totalValue',
    installments_number: 'installmentsNumber',
    base_date: 'baseDate'
};

function readCondition(pc) {
    return {
        condition_type_id: pc?.condition_type_id ?? pc?.conditionTypeId ?? null,
        condition_type_name: pc?.condition_type_name ?? pc?.conditionTypeName ?? null,
        total_value: pc?.total_value ?? pc?.totalValue ?? null,
        installments_number: pc?.installments_number ?? pc?.installmentsNumber ?? null,
        base_date: pc?.base_date ?? pc?.baseDate ?? null
    };
}

function codeOf(pc) {
    return String(readCondition(pc).condition_type_id ?? '').trim().toUpperCase();
}

// Resolve qual posição do array a edição deve atingir.
//
// A máscara precisa SOBREVIVER ao sync: o Sienge reescreve `contracts` todo dia
// e nada garante que as condições voltem na mesma ordem. Por isso a busca é em
// cascata, do mais específico ao mais tolerante:
//   1º índice gravado, se o código ainda bater (caso normal, custo zero);
//   2º única série com aquele código;
//   3º série com aquele código E o valor original de quando o ajuste nasceu
//      (desempata quando o contrato tem duas séries do mesmo código);
//   4º única série com aquele código E o valor JÁ ajustado — cobre o caso de o
//      Sienge ter sido corrigido para o valor que o admin colocou.
// Nada disso resolveu → órfã: não aplica em silêncio, vira needs_review.
function resolveTargetIndex(conditions, adj) {
    const wanted = String(adj.target_code ?? '').trim().toUpperCase();
    const idx = Number(adj.target_index);

    if (Number.isInteger(idx) && idx >= 0 && idx < conditions.length) {
        if (!wanted || codeOf(conditions[idx]) === wanted) return idx;
    }
    if (!wanted) return -1;

    const sameCode = [];
    conditions.forEach((pc, i) => { if (codeOf(pc) === wanted) sameCode.push(i); });
    if (sameCode.length === 1) return sameCode[0];
    if (!sameCode.length) return -1;

    const byValue = (alvo) => {
        if (alvo == null) return [];
        return sameCode.filter(
            (i) => Number(readCondition(conditions[i]).total_value) === Number(alvo)
        );
    };

    const comOriginal = byValue(adj.original?.total_value);
    if (comOriginal.length === 1) return comOriginal[0];

    const comAjustado = byValue(adj.payload?.total_value);
    if (comAjustado.length === 1) return comAjustado[0];

    return -1;
}

function summarize(adj, { applied, orphan_reason = null } = {}) {
    return {
        id: adj.id,
        type: adj.type,
        applied,
        orphan_reason,
        target_code: adj.target_code ?? null,
        payload: adj.payload ?? {},
        original: adj.original ?? null,
        reason: adj.reason ?? null,
        created_by_name: adj.created_by_name ?? null,
        created_at: adj.created_at ?? adj.createdAt ?? null
    };
}

/**
 * Aplica os ajustes de série nas linhas devolvidas pelo SQL do Faturamento.
 * Muta cada row acrescentando:
 *   • payment_conditions com as séries adicionadas/editadas e marcadas
 *     (_adjusted: 'added' | 'edited', _adjustment_id, _adjustment_reason);
 *   • row.adjustments = resumo de TODOS os ajustes ativos do contrato
 *     (inclusive o de data, que já foi aplicado no SQL) para o selo da tela.
 */
export async function applyAdjustmentsToRows(rows = []) {
    if (!Array.isArray(rows) || !rows.length) return rows;

    const byContract = await loadAllAdjustments(rows.map((r) => r.contract_id));
    if (!byContract.size) return rows;

    for (const row of rows) {
        const adjustments = byContract.get(String(row.contract_id));
        if (!adjustments?.length) continue;

        const conditions = Array.isArray(row.payment_conditions)
            ? row.payment_conditions.map((pc) => ({ ...pc }))
            : [];
        const summary = [];

        for (const adj of adjustments) {
            if (adj.type === 'FI_DATE') {
                // Já aplicado no SQL — aqui só entra no resumo do selo.
                summary.push(summarize(adj, { applied: true }));
                continue;
            }

            if (adj.type === 'SERIE_ADD') {
                const payload = adj.payload || {};
                conditions.push({
                    ...readCondition(payload),
                    total_value_interest: 0,
                    outstanding_balance: 0,
                    amount_paid: 0,
                    first_payment: null,
                    indexer_name: null,
                    bearer_name: null,
                    interest_type: null,
                    _adjusted: 'added',
                    _adjustment_id: adj.id,
                    _adjustment_reason: adj.reason
                });
                summary.push(summarize(adj, { applied: true }));
                continue;
            }

            if (adj.type === 'SERIE_EDIT') {
                const at = resolveTargetIndex(conditions, adj);
                if (at < 0) {
                    summary.push(summarize(adj, {
                        applied: false,
                        orphan_reason: 'A série ajustada não foi encontrada no contrato (o Sienge pode ter alterado as condições). Refaça o ajuste.'
                    }));
                    continue;
                }

                const before = readCondition(conditions[at]);
                const payload = adj.payload || {};
                const next = { ...conditions[at] };

                for (const f of SERIE_FIELDS) {
                    if (payload[f] === undefined || payload[f] === null || payload[f] === '') continue;
                    next[f] = payload[f];
                    // O par camelCase original ficaria sobrando ao lado do
                    // valor novo; a normalização do front prefere snake_case,
                    // mas deixar o dado velho no objeto só confunde na leitura.
                    delete next[CAMEL_OF[f]];
                }

                next._adjusted = 'edited';
                next._adjustment_id = adj.id;
                next._adjustment_reason = adj.reason;
                next._adjustment_before = before;
                conditions[at] = next;

                summary.push(summarize(adj, { applied: true }));
            }
        }

        row.payment_conditions = conditions;
        row.adjustments = summary;
    }

    return rows;
}

// ── Assinatura para o fechamento mensal ─────────────────────────────────────
// O fingerprint das condições é calculado em SQL sobre o JSONB CRU. Um ajuste
// de série mudaria o número do dashboard sem mexer nesse fingerprint — ou seja,
// a vigilância do mês consolidado não veria nada. O sufixo abaixo entra no
// fingerprint para que a diferença apareça como divergência explicada.
// ── Vigilância do dado de origem ────────────────────────────────────────────
//
// Um ajuste nasce sobre uma foto do contrato (`original`). O Sienge é
// ressincronizado todo dia; se o dado de origem mudar, a máscara continua
// valendo (senão o número se mexeria sozinho) mas o admin PRECISA saber.
// Exceção silenciosa: se o Sienge passou a trazer exatamente o valor ajustado,
// não há o que revisar — o ajuste vira redundante e se resolve sozinho.
const SAME_VALUE_TOLERANCE = 0.005;

function sameMoney(a, b) {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
    return Math.abs(na - nb) < SAME_VALUE_TOLERANCE;
}

function sameDay(a, b) {
    const da = a ? String(a).slice(0, 10) : null;
    const dbb = b ? String(b).slice(0, 10) : null;
    return !!da && da === dbb;
}

function sameText(a, b) {
    return String(a ?? '').trim().toUpperCase() === String(b ?? '').trim().toUpperCase();
}

// Compara um campo do payload contra o que o contrato mostra hoje.
function conditionMatches(atual, alvo) {
    if (alvo.condition_type_id != null && !sameText(atual.condition_type_id, alvo.condition_type_id)) return false;
    if (alvo.condition_type_name != null && !sameText(atual.condition_type_name, alvo.condition_type_name)) return false;
    if (alvo.total_value != null && !sameMoney(atual.total_value, alvo.total_value)) return false;
    if (alvo.installments_number != null
        && Number(atual.installments_number) !== Number(alvo.installments_number)) return false;
    if (alvo.base_date != null && !sameDay(atual.base_date, alvo.base_date)) return false;
    return true;
}

/**
 * Confronta um ajuste com o estado ATUAL do contrato no Sienge.
 * Devolve { status, source_current, message } — sem gravar nada.
 */
export function evaluateAdjustment(adj, contract) {
    if (!contract) {
        return {
            status: 'needs_review',
            source_current: null,
            message: 'O contrato não está mais na base do Sienge.'
        };
    }

    const raw = Array.isArray(contract.payment_conditions) ? contract.payment_conditions : [];

    if (adj.type === 'FI_DATE') {
        const atual = contract.financial_institution_date ?? null;
        const alvo = adj.payload?.financial_institution_date ?? null;
        const foto = adj.original?.financial_institution_date ?? null;

        if (sameDay(atual, alvo)) {
            return {
                status: 'auto_resolved',
                source_current: { financial_institution_date: atual },
                message: 'O Sienge passou a trazer a data ajustada.'
            };
        }
        if (!sameDay(atual, foto)) {
            return {
                status: 'needs_review',
                source_current: { financial_institution_date: atual },
                message: `A data no Sienge mudou de ${foto || '—'} para ${atual || '—'} depois do ajuste.`
            };
        }
        return { status: 'active', source_current: { financial_institution_date: atual }, message: null };
    }

    if (adj.type === 'SERIE_ADD') {
        const alvo = adj.payload || {};
        const code = String(alvo.condition_type_id ?? '').trim().toUpperCase();
        const iguais = raw.filter((pc) => codeOf(pc) === code);

        if (iguais.some((pc) => sameMoney(readCondition(pc).total_value, alvo.total_value))) {
            return {
                status: 'auto_resolved',
                source_current: { conditions: iguais.map(readCondition) },
                message: 'O Sienge passou a trazer essa série com o mesmo valor.'
            };
        }
        if (iguais.length) {
            return {
                status: 'needs_review',
                source_current: { conditions: iguais.map(readCondition) },
                message: `O Sienge passou a trazer a série ${code}, mas com outro valor. A série adicionada pode estar duplicando.`
            };
        }
        return { status: 'active', source_current: null, message: null };
    }

    // SERIE_EDIT
    const at = resolveTargetIndex(raw, adj);
    if (at < 0) {
        return {
            status: 'needs_review',
            source_current: null,
            message: 'A série ajustada não foi encontrada no contrato. Refaça ou remova o ajuste.'
        };
    }

    const atual = readCondition(raw[at]);
    const alvo = adj.payload || {};
    const foto = adj.original || {};

    if (conditionMatches(atual, alvo)) {
        return {
            status: 'auto_resolved',
            source_current: atual,
            message: 'O Sienge passou a trazer a série exatamente como foi ajustada.'
        };
    }
    if (!conditionMatches(atual, foto)) {
        const de = foto.total_value != null ? Number(foto.total_value).toFixed(2) : '—';
        const para = atual.total_value != null ? Number(atual.total_value).toFixed(2) : '—';
        return {
            status: 'needs_review',
            source_current: atual,
            message: `A série ${atual.condition_type_id || '—'} mudou no Sienge (valor de ${de} para ${para}) depois do ajuste.`
        };
    }
    return { status: 'active', source_current: atual, message: null };
}

// Estado CRU dos contratos (sem máscara): é contra ele que a vigilância compara.
async function loadRawContracts(contractIds = []) {
    const ids = [...new Set((contractIds || []).map((v) => String(v ?? '').trim()).filter(Boolean))];
    const map = new Map();
    if (!ids.length) return map;

    const rows = await db.sequelize.query(`
        SELECT
            sc.id::text                                  AS contract_id,
            sc.financial_institution_date::text          AS financial_institution_date,
            COALESCE(sc.payment_conditions, '[]'::jsonb) AS payment_conditions
        FROM contracts sc
        WHERE sc.id IN (:ids)
    `, { replacements: { ids }, type: db.Sequelize.QueryTypes.SELECT });

    for (const r of rows) map.set(String(r.contract_id), r);
    return map;
}

/**
 * Confere TODOS os ajustes ativos contra o Sienge atual e persiste o resultado.
 *
 * Notifica os admins só quando um ajuste ENTRA em needs_review — repetir o aviso
 * todo dia pelo mesmo ajuste viraria ruído e o alerta deixaria de ser lido.
 * Voltar a bater com a foto (ou o Sienge assumir o valor ajustado) é silencioso.
 */
export async function checkAdjustmentDrift({ notify = true } = {}) {
    const rows = await db.ContractAdjustment.findAll({
        where: { active: true },
        order: [['id', 'ASC']]
    });
    if (!rows.length) return { checked: 0, needsReview: 0, autoResolved: 0, notified: 0 };

    const contracts = await loadRawContracts(rows.map((r) => r.contract_id));
    const agora = new Date();
    const novos = [];
    let needsReview = 0;
    let autoResolved = 0;

    for (const row of rows) {
        const contract = contracts.get(String(row.contract_id)) || null;
        const veredito = evaluateAdjustment(row, contract);
        const antes = row.status || 'active';

        row.status = veredito.status;
        row.status_message = veredito.message;
        row.source_current = veredito.source_current;
        row.checked_at = agora;
        if (veredito.status !== antes) {
            row.source_changed_at = veredito.status === 'active' ? null : agora;
            // Voltou a divergir depois de revisado: precisa de revisão de novo.
            if (veredito.status === 'active') {
                row.reviewed_at = null;
                row.reviewed_by_id = null;
                row.reviewed_by_name = null;
            }
        }
        await row.save();

        if (veredito.status === 'needs_review') {
            needsReview++;
            if (antes !== 'needs_review') novos.push({ row, message: veredito.message });
        }
        if (veredito.status === 'auto_resolved') autoResolved++;
    }

    let notified = 0;
    if (notify && novos.length) {
        try {
            const admins = await db.User.findAll({ where: { role: 'admin' }, attributes: ['id'] });
            const amostra = novos.slice(0, 3)
                .map((n) => `#${n.row.contract_id} (${n.row.customer_name || 'sem cliente'}): ${n.message}`)
                .join(' | ');
            await NotificationService.notify({
                type: NotificationType.CONTRACT_ADJUSTMENT_DRIFT,
                recipients: { users: admins.map((a) => a.id) },
                title: 'Contrato ajustado mudou no Sienge',
                body: `${novos.length} ajuste(s) contábil(is) ficaram para revisar: o dado de origem mudou depois da correção. `
                    + `A correção continua valendo no relatório até você decidir. ${amostra}`,
                data: {
                    count: novos.length,
                    adjustment_ids: novos.map((n) => n.row.id),
                    contract_ids: novos.map((n) => String(n.row.contract_id))
                },
                link: '/comercial/relatorios/faturamento',
                importance: 8
            });
            notified = novos.length;
        } catch (err) {
            console.error('[contractAdjustments] Falha ao notificar drift:', err.message);
        }
    }

    return { checked: rows.length, needsReview, autoResolved, notified };
}

/**
 * Confere só os ajustes de um contrato. Usado logo depois de criar/editar um
 * ajuste, para o registro já nascer com o status certo (e para pegar na hora o
 * caso "o Sienge já está com esse valor").
 */
export async function checkAdjustmentsOfContract(contractId) {
    const rows = await db.ContractAdjustment.findAll({
        where: { active: true, contract_id: String(contractId) },
        order: [['id', 'ASC']]
    });
    if (!rows.length) return [];

    const contracts = await loadRawContracts([contractId]);
    const contract = contracts.get(String(contractId)) || null;
    const agora = new Date();

    for (const row of rows) {
        const veredito = evaluateAdjustment(row, contract);
        const antes = row.status || 'active';
        row.status = veredito.status;
        row.status_message = veredito.message;
        row.source_current = veredito.source_current;
        row.checked_at = agora;
        if (veredito.status !== antes) {
            row.source_changed_at = veredito.status === 'active' ? null : agora;
        }
        await row.save();
    }
    return rows;
}

// Quanto os ajustes de série mexem no valor somado de um contrato.
// Usado por quem soma as condições no PRÓPRIO SQL (agregado ao vivo da Eme) e
// não tem como aplicar a máscara item a item.
//   • SERIE_ADD  → soma o valor da série nova;
//   • SERIE_EDIT → soma a diferença entre o valor novo e o original.
// `dcCode` separa o desconto da construtora, que só entra num dos totais.
export function serieValueDelta(adjustments = [], { dcCode = 'DC' } = {}) {
    let all = 0;
    let exceptDc = 0;

    for (const a of adjustments || []) {
        const p = a.payload || {};
        const novo = Number(p.total_value);
        if (!Number.isFinite(novo)) continue;

        let delta = novo;
        if (a.type === 'SERIE_EDIT') {
            const antigo = Number(a.original?.total_value);
            delta = novo - (Number.isFinite(antigo) ? antigo : 0);
        } else if (a.type !== 'SERIE_ADD') {
            continue;
        }

        const code = String(p.condition_type_id ?? a.target_code ?? '').trim().toUpperCase();
        all += delta;
        if (code !== String(dcCode).toUpperCase()) exceptDc += delta;
    }

    return { all, exceptDc };
}

export function adjustmentsSignature(adjustments = []) {
    const parts = (adjustments || [])
        .filter((a) => a.type === 'SERIE_ADD' || a.type === 'SERIE_EDIT')
        .map((a) => {
            const p = a.payload || {};
            const code = String(p.condition_type_id ?? a.target_code ?? '?').toUpperCase();
            const val = p.total_value != null ? Number(p.total_value).toFixed(2) : '=';
            return `${a.type === 'SERIE_ADD' ? '+' : '~'}${code}:${val}`;
        })
        .sort();
    return parts.length ? parts.join(',') : null;
}

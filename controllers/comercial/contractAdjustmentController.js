// controllers/comercial/contractAdjustmentController.js
//
// Ajustes contábeis do Faturamento (máscara sobre o dado do contrato).
//
// TUDO aqui é admin: ajustar o dado que sustenta o relatório contábil não é
// operação de tela comum. O SELO do ajuste, esse sim, aparece para todo mundo —
// ele viaja junto com os contratos (contractAdjustmentsService), não por aqui.
import db from '../../models/sequelize/index.js';
import {
    ADJ_TYPES,
    effectiveFiDateSql,
    applyAdjustmentsToRows,
    checkAdjustmentDrift,
    checkAdjustmentsOfContract
} from '../../services/comercial/contractAdjustmentsService.js';
import { checkDivergences } from '../../services/comercial/salesClosingService.js';
import contractsCache from '../../services/sienge/contractsQueryCache.js';

const { ContractAdjustment } = db;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isAdmin(req) {
    return req.user?.role === 'admin';
}

function toNumberOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

function serialize(row) {
    const r = row.get ? row.get({ plain: true }) : row;
    return {
        id: r.id,
        contract_id: String(r.contract_id),
        type: r.type,
        enterprise_id: r.enterprise_id ?? null,
        enterprise_name: r.enterprise_name ?? null,
        customer_name: r.customer_name ?? null,
        unit_name: r.unit_name ?? null,
        target_index: r.target_index ?? null,
        target_code: r.target_code ?? null,
        payload: r.payload ?? {},
        original: r.original ?? null,
        reason: r.reason ?? null,
        // Vigilância: 'active' | 'needs_review' | 'auto_resolved'
        status: r.status ?? 'active',
        status_message: r.status_message ?? null,
        source_current: r.source_current ?? null,
        source_changed_at: r.source_changed_at ?? null,
        checked_at: r.checked_at ?? null,
        reviewed_at: r.reviewed_at ?? null,
        reviewed_by_name: r.reviewed_by_name ?? null,
        created_by_name: r.created_by_name ?? null,
        updated_by_name: r.updated_by_name ?? null,
        created_at: r.created_at ?? r.createdAt ?? null,
        updated_at: r.updated_at ?? r.updatedAt ?? null
    };
}

// Contrato + condições atuais, já com a máscara aplicada — é o que o formulário
// precisa mostrar para o admin escolher a série e ver o antes/depois.
async function loadContract(contractId) {
    const rows = await db.sequelize.query(`
        SELECT
            sc.id::text                          AS contract_id,
            sc.enterprise_id,
            sc.enterprise_name,
            sc.company_id,
            sc.company_name,
            sc.situation,
            sc.financial_institution_date::text  AS original_financial_institution_date,
            ${effectiveFiDateSql('sc')}::text    AS financial_institution_date,
            COALESCE(sc.payment_conditions, '[]'::jsonb) AS payment_conditions,
            -- Cópia CRUA, antes da máscara: é dela que sai a foto de origem de
            -- um ajuste novo. Fotografar o valor já mascarado faria a vigilância
            -- comparar ajuste contra ajuste e acusar mudança que nunca houve.
            COALESCE(sc.payment_conditions, '[]'::jsonb) AS raw_payment_conditions,
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
        WHERE sc.id = :id
        LIMIT 1
    `, { replacements: { id: contractId }, type: db.Sequelize.QueryTypes.SELECT });

    if (!rows.length) return null;
    await applyAdjustmentsToRows(rows);
    return rows[0];
}

// Roda a vigilância do fechamento na hora: se o ajuste mexeu num mês já
// consolidado, a divergência é registrada e os admins notificados agora, não só
// às 03:30 do dia seguinte. Falha aqui não pode derrubar o salvamento.
async function reviewClosingsNow() {
    try {
        const r = await checkDivergences({ notify: true });
        return r?.newDivergences || 0;
    } catch (err) {
        console.error('[contractAdjustment] Falha ao revisar fechamentos:', err.message);
        return 0;
    }
}

/**
 * GET /api/admin/contract-adjustments
 * Lista todos os ajustes ativos (aba Ajustes contábeis da engrenagem).
 */
export async function listContractAdjustments(req, res) {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Acesso negado.' });

        // O status vem persistido pela vigilância (scheduler + checagem a cada
        // mutação). Recalcular aqui, contrato a contrato, era caro e deixava a
        // aba lenta conforme os ajustes se acumulavam.
        const rows = await ContractAdjustment.findAll({
            where: { active: true },
            order: [['created_at', 'DESC']]
        });

        return res.json({ count: rows.length, results: rows.map(serialize) });
    } catch (err) {
        console.error('[listContractAdjustments]', err);
        return res.status(500).json({ error: 'Erro ao listar ajustes contábeis.' });
    }
}

/**
 * GET /api/admin/contract-adjustments/contracts?q=
 * Busca contrato por número, cliente ou unidade — é o ponto de entrada do
 * ajuste quando ele nasce na engrenagem (fora do modal de detalhe).
 */
export async function lookupContracts(req, res) {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Acesso negado.' });

        const q = String(req.query.q ?? '').trim();
        if (q.length < 2) return res.json({ count: 0, results: [] });

        const asId = /^\d+$/.test(q) ? q : null;

        const rows = await db.sequelize.query(`
            SELECT
                sc.id::text                       AS contract_id,
                sc.enterprise_id,
                sc.enterprise_name,
                sc.company_name,
                sc.situation,
                ${effectiveFiDateSql('sc')}::text AS financial_institution_date,
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
            WHERE (:asId IS NOT NULL AND sc.id::text = :asId)
               OR EXISTS (
                    SELECT 1 FROM jsonb_array_elements(sc.customers) c
                    WHERE unaccent(upper(c ->> 'name')) LIKE unaccent(upper(:like))
                  )
               OR EXISTS (
                    SELECT 1 FROM jsonb_array_elements(sc.units) u
                    WHERE unaccent(upper(u ->> 'name')) LIKE unaccent(upper(:like))
                  )
            ORDER BY sc.financial_institution_date DESC NULLS LAST, sc.id DESC
            LIMIT 25
        `, {
            replacements: { asId, like: `%${q}%` },
            type: db.Sequelize.QueryTypes.SELECT
        });

        return res.json({ count: rows.length, results: rows });
    } catch (err) {
        console.error('[lookupContracts]', err);
        return res.status(500).json({ error: 'Erro ao buscar contratos.' });
    }
}

/**
 * GET /api/admin/contract-adjustments/contracts/:contractId
 * Contrato completo (data efetiva + séries já mascaradas) para montar o form.
 */
export async function getContractForAdjustment(req, res) {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Acesso negado.' });

        const id = String(req.params.contractId ?? '').trim();
        if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Número de contrato inválido.' });

        const contract = await loadContract(id);
        if (!contract) return res.status(404).json({ error: 'Contrato não encontrado.' });

        return res.json(contract);
    } catch (err) {
        console.error('[getContractForAdjustment]', err);
        return res.status(500).json({ error: 'Erro ao carregar contrato.' });
    }
}

// `isUpdate`: ao editar um ajuste que já existe, a série alvo naturalmente
// aparece marcada como ajustada (por ele mesmo) — a trava de empilhamento não
// vale nesse caso.
function validate({ type, payload, target_index, target_code }, contract, { isUpdate = false } = {}) {
    if (!ADJ_TYPES.includes(type)) return 'Tipo de ajuste inválido.';

    if (type === 'FI_DATE') {
        const d = String(payload?.financial_institution_date ?? '').trim();
        if (!DATE_RE.test(d)) return 'Informe a nova data no formato AAAA-MM-DD.';
        if (Number.isNaN(new Date(`${d}T00:00:00Z`).getTime())) return 'Data inválida.';
        return null;
    }

    if (type === 'SERIE_ADD') {
        if (!String(payload?.condition_type_id ?? '').trim()) return 'Informe o código da série.';
        if (toNumberOrNull(payload?.total_value) === null) return 'Informe o valor da série.';
        return null;
    }

    // SERIE_EDIT
    const idx = Number(target_index);
    if (!Number.isInteger(idx) || idx < 0) return 'Selecione a série que será editada.';
    if (!String(target_code ?? '').trim()) return 'Série alvo sem código identificador.';
    const conditions = Array.isArray(contract?.payment_conditions) ? contract.payment_conditions : [];
    if (idx >= conditions.length) return 'A série selecionada não existe mais neste contrato.';
    const hasChange = ['condition_type_id', 'condition_type_name', 'total_value', 'installments_number', 'base_date']
        .some((f) => payload?.[f] !== undefined && payload?.[f] !== null && payload?.[f] !== '');
    if (!hasChange) return 'Informe pelo menos um campo para alterar na série.';

    if (isUpdate) return null;

    // Ajuste sobre ajuste é proibido: a vigilância compara o ajuste com a
    // ORIGEM, e uma pilha de correções não tem origem única para comparar.
    const alvo = conditions[idx] || {};
    if (alvo._adjusted === 'added') {
        return 'Essa série foi adicionada por ajuste. Corrija o próprio ajuste de adição.';
    }
    if (alvo._adjusted === 'edited') {
        return 'Essa série já tem um ajuste ativo. Edite o ajuste existente em vez de criar outro.';
    }
    return null;
}

// Normaliza o payload: número vira número, texto vira texto aparado, e só entra
// o que o tipo do ajuste realmente usa (nada de campo solto no JSONB).
function buildPayload(type, raw = {}) {
    if (type === 'FI_DATE') {
        return { financial_institution_date: String(raw.financial_institution_date).trim() };
    }
    const out = {};
    if (raw.condition_type_id != null && String(raw.condition_type_id).trim() !== '') {
        out.condition_type_id = String(raw.condition_type_id).trim().toUpperCase();
    }
    if (raw.condition_type_name != null && String(raw.condition_type_name).trim() !== '') {
        out.condition_type_name = String(raw.condition_type_name).trim();
    }
    if (toNumberOrNull(raw.total_value) !== null) out.total_value = toNumberOrNull(raw.total_value);
    if (toNumberOrNull(raw.installments_number) !== null) {
        out.installments_number = Math.trunc(toNumberOrNull(raw.installments_number));
    }
    if (raw.base_date != null && DATE_RE.test(String(raw.base_date).trim())) {
        out.base_date = String(raw.base_date).trim();
    }
    return out;
}

/**
 * POST /api/admin/contract-adjustments
 */
export async function createContractAdjustment(req, res) {
    try {
        // O ajuste muda a data ou a série do contrato: a resposta cacheada
        // do faturamento deixa de valer.
        contractsCache.invalidate('ajuste contabil');
        if (!isAdmin(req)) return res.status(403).json({ error: 'Acesso negado.' });

        const { contract_id, type, target_index, target_code, reason } = req.body || {};

        const cid = String(contract_id ?? '').trim();
        if (!/^\d+$/.test(cid)) return res.status(400).json({ error: 'Número de contrato inválido.' });

        const motivo = String(reason ?? '').trim();
        if (motivo.length < 3) return res.status(400).json({ error: 'Descreva o motivo contábil do ajuste.' });

        const contract = await loadContract(cid);
        if (!contract) return res.status(404).json({ error: 'Contrato não encontrado.' });

        const payload = buildPayload(type, req.body?.payload || {});
        const problem = validate({ type, payload, target_index, target_code }, contract);
        if (problem) return res.status(400).json({ error: problem });

        // Snapshot do que está sendo substituído — é o que sustenta o "de X para
        // Y" no selo e na auditoria, mesmo que o Sienge mude depois.
        let original = null;
        if (type === 'FI_DATE') {
            original = { financial_institution_date: contract.original_financial_institution_date ?? null };
        } else if (type === 'SERIE_EDIT') {
            // Da lista CRUA: a foto tem que ser o que o Sienge manda hoje, não o
            // que a máscara mostra. É contra ela que a vigilância compara depois.
            const raw = Array.isArray(contract.raw_payment_conditions) ? contract.raw_payment_conditions : [];
            const pc = raw[Number(target_index)] || {};
            original = {
                condition_type_id: pc.condition_type_id ?? pc.conditionTypeId ?? null,
                condition_type_name: pc.condition_type_name ?? pc.conditionTypeName ?? null,
                total_value: pc.total_value ?? pc.totalValue ?? null,
                installments_number: pc.installments_number ?? pc.installmentsNumber ?? null,
                base_date: pc.base_date ?? pc.baseDate ?? null
            };
        }

        const common = {
            contract_id: cid,
            type,
            enterprise_id: contract.enterprise_id ?? null,
            enterprise_name: contract.enterprise_name ?? null,
            customer_name: contract.customer_name ?? null,
            unit_name: contract.unit_name ?? null,
            target_index: type === 'SERIE_EDIT' ? Number(target_index) : null,
            target_code: type === 'SERIE_EDIT' ? String(target_code).trim().toUpperCase() : null,
            payload,
            original,
            reason: motivo,
            active: true,
            created_by_id: req.user?.id ?? null,
            created_by_name: req.user?.name ?? req.user?.email ?? null
        };

        // Data da instituição financeira é uma só: um segundo ajuste do mesmo
        // tipo substitui o anterior em vez de empilhar (o índice único parcial
        // no banco não deixaria mesmo).
        let row;
        if (type === 'FI_DATE') {
            const existing = await ContractAdjustment.findOne({
                where: { contract_id: cid, type: 'FI_DATE', active: true }
            });
            if (existing) {
                existing.set({
                    payload,
                    reason: motivo,
                    updated_by_id: req.user?.id ?? null,
                    updated_by_name: req.user?.name ?? req.user?.email ?? null
                });
                await existing.save();
                row = existing;
            }
        }
        if (!row) row = await ContractAdjustment.create(common);

        // Já nasce com o status certo: se o Sienge por acaso já estiver com o
        // valor informado, o ajuste se resolve na hora e não vira pendência.
        await checkAdjustmentsOfContract(cid);
        await row.reload();

        const newDivergences = await reviewClosingsNow();
        return res.status(201).json({ ...serialize(row), new_divergences: newDivergences });
    } catch (err) {
        console.error('[createContractAdjustment]', err);
        return res.status(500).json({ error: 'Erro ao salvar ajuste contábil.' });
    }
}

/**
 * PUT /api/admin/contract-adjustments/:id
 * Altera valores e motivo. Tipo e contrato não mudam — para isso, remova e crie.
 */
export async function updateContractAdjustment(req, res) {
    try {
        // O ajuste muda a data ou a série do contrato: a resposta cacheada
        // do faturamento deixa de valer.
        contractsCache.invalidate('ajuste contabil');
        if (!isAdmin(req)) return res.status(403).json({ error: 'Acesso negado.' });

        const idInt = Number(req.params.id);
        if (!Number.isInteger(idInt)) return res.status(400).json({ error: 'ID inválido.' });

        const row = await ContractAdjustment.findByPk(idInt);
        if (!row || row.active === false) return res.status(404).json({ error: 'Ajuste não encontrado.' });

        const contract = await loadContract(String(row.contract_id));
        if (!contract) return res.status(404).json({ error: 'Contrato não encontrado.' });

        if (req.body?.payload !== undefined) {
            const payload = buildPayload(row.type, req.body.payload || {});
            const problem = validate({
                type: row.type,
                payload,
                target_index: row.target_index,
                target_code: row.target_code
            }, contract, { isUpdate: true });
            if (problem) return res.status(400).json({ error: problem });
            row.payload = payload;
        }

        if (req.body?.reason !== undefined) {
            const motivo = String(req.body.reason ?? '').trim();
            if (motivo.length < 3) return res.status(400).json({ error: 'Descreva o motivo contábil do ajuste.' });
            row.reason = motivo;
        }

        row.updated_by_id = req.user?.id ?? null;
        row.updated_by_name = req.user?.name ?? req.user?.email ?? null;
        // Editar o ajuste zera a revisão anterior: o que foi conferido era outro
        // valor.
        row.reviewed_at = null;
        row.reviewed_by_id = null;
        row.reviewed_by_name = null;
        await row.save();

        await checkAdjustmentsOfContract(String(row.contract_id));
        await row.reload();

        const newDivergences = await reviewClosingsNow();
        return res.json({ ...serialize(row), new_divergences: newDivergences });
    } catch (err) {
        console.error('[updateContractAdjustment]', err);
        return res.status(500).json({ error: 'Erro ao atualizar ajuste contábil.' });
    }
}

/**
 * POST /api/admin/contract-adjustments/check
 * Roda a vigilância na hora ("Conferir agora"), sem esperar o cron das 03:40.
 * Notifica igual ao scheduler: quem clicou pode não ser quem precisa saber.
 */
export async function runAdjustmentCheck(req, res) {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Acesso negado.' });
        const result = await checkAdjustmentDrift({ notify: true });
        return res.json(result);
    } catch (err) {
        console.error('[runAdjustmentCheck]', err);
        return res.status(500).json({ error: 'Erro ao conferir os ajustes.' });
    }
}

/**
 * PUT /api/admin/contract-adjustments/:id/review
 * "Já conferi": o admin viu a mudança na origem e decidiu manter o ajuste como
 * está. Volta para 'active' e a nova foto vira a referência — senão a próxima
 * varredura reabriria a mesma pendência todo dia.
 */
export async function reviewContractAdjustment(req, res) {
    try {
        // O ajuste muda a data ou a série do contrato: a resposta cacheada
        // do faturamento deixa de valer.
        contractsCache.invalidate('ajuste contabil');
        if (!isAdmin(req)) return res.status(403).json({ error: 'Acesso negado.' });

        const idInt = Number(req.params.id);
        if (!Number.isInteger(idInt)) return res.status(400).json({ error: 'ID inválido.' });

        const row = await ContractAdjustment.findByPk(idInt);
        if (!row || row.active === false) return res.status(404).json({ error: 'Ajuste não encontrado.' });

        if (row.source_current) row.original = row.source_current;
        row.status = 'active';
        row.status_message = null;
        row.source_changed_at = null;
        row.reviewed_at = new Date();
        row.reviewed_by_id = req.user?.id ?? null;
        row.reviewed_by_name = req.user?.name ?? req.user?.email ?? null;
        await row.save();

        return res.json(serialize(row));
    } catch (err) {
        console.error('[reviewContractAdjustment]', err);
        return res.status(500).json({ error: 'Erro ao marcar o ajuste como conferido.' });
    }
}

/**
 * DELETE /api/admin/contract-adjustments/:id
 * Desativa (soft delete): o histórico do que já foi corrigido não se apaga.
 */
export async function removeContractAdjustment(req, res) {
    try {
        // O ajuste muda a data ou a série do contrato: a resposta cacheada
        // do faturamento deixa de valer.
        contractsCache.invalidate('ajuste contabil');
        if (!isAdmin(req)) return res.status(403).json({ error: 'Acesso negado.' });

        const idInt = Number(req.params.id);
        if (!Number.isInteger(idInt)) return res.status(400).json({ error: 'ID inválido.' });

        const row = await ContractAdjustment.findByPk(idInt);
        if (!row) return res.status(404).json({ error: 'Ajuste não encontrado.' });

        row.active = false;
        row.updated_by_id = req.user?.id ?? null;
        row.updated_by_name = req.user?.name ?? req.user?.email ?? null;
        await row.save();

        const newDivergences = await reviewClosingsNow();
        return res.json({ success: true, new_divergences: newDivergences });
    } catch (err) {
        console.error('[removeContractAdjustment]', err);
        return res.status(500).json({ error: 'Erro ao remover ajuste contábil.' });
    }
}

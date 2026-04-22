// controllers/comercial/enterpriseConditionController.js
import db from '../../models/sequelize/index.js';

const {
    EnterpriseCondition,
    EnterpriseConditionModule,
    EnterpriseConditionCampaign,
    CvEnterprise,
    CvEnterpriseStage,
    CvEnterpriseBlock,
    CvEnterpriseUnit,
    CvEnterprisePriceTable,
    CvCorrespondent,
    SignatureDocument,
    SignatureDocumentSigner,
    ComercialSettings,
    User,
} = db;

const sequelize = db.sequelize;

// ─── helpers ─────────────────────────────────────────────────────────────────

function toMonth(dateStr) {
    if (!dateStr) return null;
    if (/^\d{4}-\d{2}$/.test(dateStr)) return `${dateStr}-01`;
    return dateStr.substring(0, 10);
}

function isAdmin(req) {
    return req.user?.role === 'admin';
}

function addHistory(current = [], action, req, note = null) {
    return [
        ...current,
        {
            action,
            user_id: req.user?.id,
            username: req.user?.username || req.user?.email,
            at: new Date().toISOString(),
            note,
        },
    ];
}

// Campos a ignorar no diff (controle, timestamps, etc.)
const DIFF_IGNORE_FIELDS = new Set([
    'id', 'idempreendimento', 'reference_month', 'status',
    'submitted_at', 'submitted_by', 'approved_at', 'signature_document_id',
    'unlocked_at', 'unlocked_by', 'approval_history',
    'created_by', 'updated_by', 'createdAt', 'updatedAt',
    'modules', 'campaigns', 'realtors_snapshot', 'cv_documents',
]);

function buildDiffNote(before, after) {
    const changes = [];
    for (const [key, newVal] of Object.entries(after)) {
        if (DIFF_IGNORE_FIELDS.has(key)) continue;
        const oldVal = before[key];
        // Normalize for comparison
        const norm = (v) => (v === undefined || v === '' ? null : v);
        const o = norm(oldVal);
        const n = norm(newVal);
        if (JSON.stringify(o) !== JSON.stringify(n)) {
            changes.push(`${key}: ${o ?? '∅'} → ${n ?? '∅'}`);
        }
    }
    if (!changes.length) return null;
    return `Alterações: ${changes.join(', ')}`;
}

// ─── validação de regras de negócio por módulo ───────────────────────────────

function validateModuleRules(mod) {
    const errors = [];
    const name = mod.module_name ? `"${mod.module_name}"` : `Módulo`;

    // Valores monetários não negativos
    const moneyFields = {
        max_entry_value:      'Valor máx. entrada',
        rp_installment_value: 'Parcela RP',
        act_installment_value: 'Parcela ACT',
        min_installment_value: 'Parcela mínima',
        appraisal_value:      'Valor de avaliação',
        appraisal_ceiling:    'Teto da cidade',
    };
    for (const [field, label] of Object.entries(moneyFields)) {
        if (mod[field] != null && Number(mod[field]) < 0) {
            errors.push(`${name}: "${label}" não pode ser negativo`);
        }
    }

    // Número de parcelas positivo
    if (mod.max_installments != null && Number(mod.max_installments) <= 0) {
        errors.push(`${name}: número máximo de parcelas deve ser positivo`);
    }

    // Prazo de entrega não negativo
    if (mod.delivery_deadline_months != null && Number(mod.delivery_deadline_months) < 0) {
        errors.push(`${name}: prazo de entrega não pode ser negativo`);
    }

    // Subsídio estadual: estado obrigatório quando ativo
    if (mod.has_state_subsidy) {
        const hasState = mod.state_subsidy_state || mod.state_subsidy_custom_state;
        if (!hasState) {
            errors.push(`${name}: informe o estado do subsídio estadual quando o subsídio está ativado`);
        }
    }

    // Registro por outros: nome de contato obrigatório
    if (mod.contract_registration_by === 'outros' && !mod.outros_contact_name) {
        errors.push(`${name}: informe o nome do contato externo quando o registro é feito por terceiros`);
    }

    return errors;
}

async function getUnitCountForStage(idetapa) {
    const blocks = await CvEnterpriseBlock.findAll({
        where: { idetapa },
        attributes: ['total_unidades'],
    });
    return blocks.reduce((sum, b) => sum + (b.total_unidades ?? 0), 0);
}

async function getPriceDistribution(idempreendimento, idetapa = null) {
    const stages = idetapa
        ? [{ idetapa }]
        : await CvEnterpriseStage.findAll({
            where: { idempreendimento },
            attributes: ['idetapa'],
        });

    const stageIds = stages.map(s => s.idetapa);
    if (!stageIds.length) return [];

    const blocks = await CvEnterpriseBlock.findAll({
        where: { idetapa: stageIds },
        attributes: ['idbloco'],
    });
    const blockIds = blocks.map(b => b.idbloco);
    if (!blockIds.length) return [];

    const units = await CvEnterpriseUnit.findAll({
        where: { idbloco: blockIds },
        attributes: ['idunidade', 'nome', 'valor', 'tipologia'],
    });

    const grouped = new Map();
    for (const u of units) {
        if (u.valor == null) continue;
        const v = Number(u.valor);
        const bucket = Math.round(v / 1000) * 1000;
        if (!grouped.has(bucket)) {
            grouped.set(bucket, { value: bucket, exactValues: new Set(), count: 0, units: [] });
        }
        const g = grouped.get(bucket);
        g.exactValues.add(v);
        g.count++;
        g.units.push({ idunidade: u.idunidade, nome: u.nome, valor: v, tipologia: u.tipologia });
    }

    if (grouped.size === 1) {
        grouped.clear();
        for (const u of units) {
            if (u.valor == null) continue;
            const v = Number(u.valor);
            const bucket = Math.round(v / 100) * 100;
            if (!grouped.has(bucket)) {
                grouped.set(bucket, { value: bucket, exactValues: new Set(), count: 0, units: [] });
            }
            const g = grouped.get(bucket);
            g.exactValues.add(v);
            g.count++;
            g.units.push({ idunidade: u.idunidade, nome: u.nome, valor: v, tipologia: u.tipologia });
        }
    }

    return [...grouped.values()]
        .sort((a, b) => b.count - a.count)
        .map(g => ({
            bucket_value: g.value,
            exact_values: [...g.exactValues].sort((a, b) => a - b),
            unit_count: g.count,
            units: g.units.sort((a, b) => a.valor - b.valor),
        }));
}

// ─── listagem ─────────────────────────────────────────────────────────────────
// Admin vê todos os status. Usuário comum vê apenas fichas 'approved'.

export const listConditions = async (req, res) => {
    try {
        const { idempreendimento } = req.query;

        const where = {};
        if (idempreendimento) where.idempreendimento = Number(idempreendimento);
        if (!isAdmin(req)) where.status = 'approved';

        const conditions = await EnterpriseCondition.findAll({
            where,
            include: [
                { model: CvEnterprise, as: 'enterprise', attributes: ['idempreendimento', 'nome', 'cidade', 'segmento_nome', 'situacao_comercial_nome', 'logo'] },
                { model: EnterpriseConditionModule, as: 'modules', attributes: ['id', 'module_name', 'total_units', 'min_demand', 'sort_order'] },
            ],
            order: [['reference_month', 'DESC'], ['idempreendimento', 'ASC']],
        });

        return res.json(conditions);
    } catch (e) {
        console.error('[conditions] listConditions:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// ─── detalhe ─────────────────────────────────────────────────────────────────
// Usuário comum só acessa ficha 'approved'.

export const getCondition = async (req, res) => {
    try {
        const { id } = req.params;

        const condition = await EnterpriseCondition.findByPk(id, {
            include: [
                { model: CvEnterprise, as: 'enterprise', attributes: ['idempreendimento', 'nome', 'cidade', 'estado', 'segmento_nome', 'situacao_comercial_nome', 'logo', 'tipo_empreendimento_nome'] },
                {
                    model: EnterpriseConditionModule,
                    as: 'modules',
                    separate: true,
                    order: [['sort_order', 'ASC']],
                    include: [
                        {
                            model: EnterpriseConditionCampaign,
                            as: 'campaigns',
                            separate: true,
                            order: [['sort_order', 'ASC']],
                        },
                    ],
                },
                { model: CvCorrespondent, as: 'correspondent', attributes: ['idusuario', 'idempresa', 'nome', 'telefone', 'celular', 'email'] },
            ],
        });

        if (!condition) return res.status(404).json({ error: 'Ficha não encontrada.' });
        if (!isAdmin(req) && condition.status !== 'approved') {
            return res.status(403).json({ error: 'Acesso restrito a fichas autorizadas.' });
        }

        let priceTables = [];
        if (condition.price_table_ids?.length) {
            priceTables = await CvEnterprisePriceTable.findAll({
                where: { idtabela: condition.price_table_ids },
                attributes: ['idtabela', 'nome', 'ativo_painel', 'aprovado', 'data_vigencia_de', 'data_vigencia_ate', 'porcentagem_comissao', 'maximo_parcelas', 'forma'],
            });
        }

        // Histórico de fichas do mesmo empreendimento (para navegação)
        const history = await EnterpriseCondition.findAll({
            where: {
                idempreendimento: condition.idempreendimento,
                ...(isAdmin(req) ? {} : { status: 'approved' }),
            },
            attributes: ['id', 'reference_month', 'status'],
            order: [['reference_month', 'DESC']],
        });

        // Etapas do CV disponíveis para o empreendimento
        const stages = await CvEnterpriseStage.findAll({
            where: { idempreendimento: condition.idempreendimento },
            attributes: ['idetapa', 'nome', 'idempreendimento'],
            order: [['idetapa', 'ASC']],
        });

        return res.json({ ...condition.toJSON(), priceTables, history, stages });
    } catch (e) {
        console.error('[conditions] getCondition:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// ─── helper: gera/atualiza fichas em draft para meses de uma faixa ──────────
// selectedStageIds: apenas estas etapas são criadas/adicionadas.
// Para meses que já existem (em draft), adiciona só os módulos ausentes.

async function generateMonthsRange(idempreendimento, fromMonthStr, toMonthStr, userId, username, selectedStageIds = []) {
    const stageWhere = { idempreendimento };
    if (selectedStageIds.length) stageWhere.idetapa = selectedStageIds.map(Number);

    const stages = await CvEnterpriseStage.findAll({
        where: stageWhere,
        order: [['idetapa', 'ASC']],
    });
    if (!stages.length) return [];

    let cursor = new Date(fromMonthStr + 'T00:00:00Z');
    const generated = [];

    while (true) {
        const mStr = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}-01`;
        if (mStr > toMonthStr) break;

        const existing = await EnterpriseCondition.findOne({
            where: { idempreendimento, reference_month: mStr },
            include: [{ model: EnterpriseConditionModule, as: 'modules', attributes: ['idetapa', 'sort_order'] }],
        });

        if (!existing) {
            // Cria ficha nova com os módulos selecionados
            const newCond = await EnterpriseCondition.create({
                idempreendimento,
                reference_month: mStr,
                status: 'draft',
                approval_history: [{
                    action: 'auto_created',
                    user_id: userId,
                    username,
                    at: new Date().toISOString(),
                    note: `Criado automaticamente ao iniciar ficha de ${fromMonthStr.substring(0, 7)}`,
                }],
                created_by: userId,
                updated_by: userId,
            });

            for (let i = 0; i < stages.length; i++) {
                const stage = stages[i];
                const totalUnits = await getUnitCountForStage(stage.idetapa);
                await EnterpriseConditionModule.create({
                    condition_id: newCond.id,
                    idetapa: stage.idetapa,
                    module_name: stage.nome,
                    sort_order: i,
                    total_units: totalUnits,
                    min_demand: Math.ceil(totalUnits * 0.2),
                    price_table_ids: [],
                    manual_price_tables: [],
                });
            }
            generated.push(mStr);
        } else if (existing.status !== 'approved') {
            // Ficha existe em draft/pending: adiciona apenas os módulos ausentes
            const existingStageIds = new Set(
                (existing.modules ?? []).map(m => m.idetapa).filter(Boolean)
            );
            const toAdd = stages.filter(s => !existingStageIds.has(s.idetapa));
            if (toAdd.length) {
                const sortBase = (existing.modules ?? []).length;
                for (let i = 0; i < toAdd.length; i++) {
                    const stage = toAdd[i];
                    const totalUnits = await getUnitCountForStage(stage.idetapa);
                    await EnterpriseConditionModule.create({
                        condition_id: existing.id,
                        idetapa: stage.idetapa,
                        module_name: stage.nome,
                        sort_order: sortBase + i,
                        total_units: totalUnits,
                        min_demand: Math.ceil(totalUnits * 0.2),
                        price_table_ids: [],
                        manual_price_tables: [],
                    });
                }
                generated.push(mStr);
            }
        }
        // Se approved: deixa intocada

        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }

    return generated;
}

// ─── criação — somente admin ──────────────────────────────────────────────────

export const createCondition = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores podem criar fichas.' });

        const userId = req.user?.id;
        const { idempreendimento, reference_month, selectedStageIds, ...rest } = req.body;

        if (!idempreendimento || !reference_month) {
            return res.status(400).json({ error: 'idempreendimento e reference_month são obrigatórios.' });
        }

        const month = toMonth(reference_month);
        const normalizedStageIds = Array.isArray(selectedStageIds) && selectedStageIds.length
            ? selectedStageIds.map(Number)
            : [];

        // Busca etapas selecionadas (vazio = apenas módulo avulso, sem etapas CV)
        let stages = [];
        if (normalizedStageIds.length) {
            stages = await CvEnterpriseStage.findAll({
                where: { idempreendimento, idetapa: normalizedStageIds },
                order: [['idetapa', 'ASC']],
            });
        }

        // Verifica se já existe ficha para o mês solicitado
        const existingCond = await EnterpriseCondition.findOne({
            where: { idempreendimento, reference_month: month },
            include: [{ model: EnterpriseConditionModule, as: 'modules', attributes: ['idetapa', 'sort_order'] }],
        });

        let condition;

        if (existingCond) {
            // Ficha existe — só adiciona módulos que ainda não estão presentes
            if (existingCond.status === 'approved') {
                return res.status(409).json({ error: 'A ficha deste mês já está aprovada. Desbloqueie-a antes de adicionar módulos.' });
            }
            const existingStageIds = new Set(
                (existingCond.modules ?? []).map(m => m.idetapa).filter(Boolean)
            );
            const toAdd = stages.filter(s => !existingStageIds.has(s.idetapa));
            if (!toAdd.length) {
                return res.status(409).json({ error: 'Todos os módulos selecionados já existem nesta ficha.' });
            }
            const sortBase = (existingCond.modules ?? []).length;
            for (let i = 0; i < toAdd.length; i++) {
                const stage = toAdd[i];
                const totalUnits = await getUnitCountForStage(stage.idetapa);
                await EnterpriseConditionModule.create({
                    condition_id: existingCond.id,
                    idetapa: stage.idetapa,
                    module_name: stage.nome,
                    sort_order: sortBase + i,
                    total_units: totalUnits,
                    min_demand: Math.ceil(totalUnits * 0.2),
                    price_table_ids: [],
                    manual_price_tables: [],
                });
            }
            condition = existingCond;
        } else {
            // Cria ficha nova com os módulos selecionados
            condition = await sequelize.transaction(async (t) => {
                const cond = await EnterpriseCondition.create({
                    idempreendimento,
                    reference_month: month,
                    ...rest,
                    status: 'draft',
                    approval_history: [{ action: 'created', user_id: userId, username: req.user?.username, at: new Date().toISOString() }],
                    created_by: userId,
                    updated_by: userId,
                }, { transaction: t });

                for (let i = 0; i < stages.length; i++) {
                    const stage = stages[i];
                    const totalUnits = await getUnitCountForStage(stage.idetapa);
                    await EnterpriseConditionModule.create({
                        condition_id: cond.id,
                        idetapa: stage.idetapa,
                        module_name: stage.nome,
                        sort_order: i,
                        total_units: totalUnits,
                        min_demand: Math.ceil(totalUnits * 0.2),
                        price_table_ids: [],
                        manual_price_tables: [],
                    }, { transaction: t });
                }

                return cond;
            });
        }

        // Propaga os módulos selecionados para meses seguintes até o atual
        // Módulos avulsos (sem etapas CV) não se propagam automaticamente
        const now = new Date();
        const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

        let generatedMonths = [];
        if (normalizedStageIds.length && month < currentMonthStr) {
            const nextMonthCursor = new Date(month + 'T00:00:00Z');
            nextMonthCursor.setUTCMonth(nextMonthCursor.getUTCMonth() + 1);
            const nextMonthStr = `${nextMonthCursor.getUTCFullYear()}-${String(nextMonthCursor.getUTCMonth() + 1).padStart(2, '0')}-01`;

            generatedMonths = await generateMonthsRange(
                idempreendimento, nextMonthStr, currentMonthStr,
                userId, req.user?.username,
                normalizedStageIds,
            );
        }

        return res.status(existingCond ? 200 : 201).json({ id: condition.id, generatedMonths });
    } catch (e) {
        console.error('[conditions] createCondition:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// ─── atualização — somente admin, somente se não aprovada ────────────────────

export const updateCondition = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores podem editar fichas.' });

        const { id } = req.params;
        const userId = req.user?.id;

        const condition = await EnterpriseCondition.findByPk(id);
        if (!condition) return res.status(404).json({ error: 'Ficha não encontrada.' });
        if (condition.status === 'approved') {
            return res.status(409).json({ error: 'Ficha aprovada está bloqueada. Desbloqueie antes de editar.' });
        }

        const { modules, campaigns, ...fields } = req.body;
        // Impede mudança manual de status por esta rota
        delete fields.status;

        // Gera diff para o histórico
        const before = condition.toJSON();
        const diffNote = buildDiffNote(before, fields);

        // Se a ficha já passou por um desbloqueio, registra como 'edited_after_unlock'
        const wasUnlocked = (condition.approval_history ?? []).some(h => h.action === 'unlocked');
        const saveAction = wasUnlocked ? 'edited_after_unlock' : 'saved';

        let newHistory = condition.approval_history ?? [];
        if (diffNote) {
            newHistory = addHistory(newHistory, saveAction, req, diffNote);
        }

        await condition.update({
            ...fields,
            ...(diffNote ? { approval_history: newHistory } : {}),
            updated_by: userId,
        });

        return res.json({ ok: true });
    } catch (e) {
        console.error('[conditions] updateCondition:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// ─── enviar para autorização — draft → pending_approval ──────────────────────

export const submitForApproval = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores podem enviar fichas para autorização.' });

        const { id } = req.params;
        const condition = await EnterpriseCondition.findByPk(id, {
            include: [{ model: CvEnterprise, as: 'enterprise', attributes: ['nome'] }],
        });
        if (!condition) return res.status(404).json({ error: 'Ficha não encontrada.' });
        if (condition.status !== 'draft') {
            return res.status(409).json({ error: `Ficha está em "${condition.status}" — só rascunhos podem ser enviados.` });
        }

        // Busca configurações de aprovadores
        const settings = await ComercialSettings.findOne({ where: { id: 1 } });
        const approver1Id = settings?.approver_1_id;
        const approver2Id = settings?.approver_2_id;

        if (!approver1Id && !approver2Id) {
            return res.status(422).json({ error: 'Nenhum aprovador configurado. Configure os aprovadores em Configurações > Comercial.' });
        }

        // Cria SignatureDocument com os aprovadores configurados
        const enterpriseName = condition.enterprise?.nome || `Empreendimento #${condition.idempreendimento}`;
        const monthLabel = condition.reference_month?.substring(0, 7);

        const signers = [approver1Id, approver2Id].filter(Boolean);
        const signDoc = await SignatureDocument.create({
            created_by: req.user?.id,
            document_name: `Ficha Comercial — ${enterpriseName} — ${monthLabel}`,
            status: 'PENDING',
            required_signers_count: signers.length,
            signed_signers_count: 0,
        });

        for (let i = 0; i < signers.length; i++) {
            await SignatureDocumentSigner.create({
                document_id: signDoc.id,
                user_id: signers[i],
                requested_by: req.user?.id,
                sign_order: i + 1,
                is_required: true,
                status: 'PENDING',
            });
        }

        const newHistory = addHistory(condition.approval_history, 'submitted_for_approval', req);
        await condition.update({
            status: 'pending_approval',
            submitted_at: new Date(),
            submitted_by: req.user?.id,
            signature_document_id: signDoc.id,
            approval_history: newHistory,
            updated_by: req.user?.id,
        });

        return res.json({ ok: true, status: 'pending_approval', signatureDocumentId: signDoc.id });
    } catch (e) {
        console.error('[conditions] submitForApproval:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// ─── desbloquear — approved → draft (admin, com histórico) ───────────────────

export const unlockCondition = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores podem desbloquear fichas.' });

        const { id } = req.params;
        const condition = await EnterpriseCondition.findByPk(id);
        if (!condition) return res.status(404).json({ error: 'Ficha não encontrada.' });
        if (condition.status !== 'approved') {
            return res.status(409).json({ error: 'Apenas fichas aprovadas podem ser desbloqueadas.' });
        }

        // Cancela o SignatureDocument anterior, se existir
        if (condition.signature_document_id && SignatureDocument) {
            await SignatureDocument.update(
                { status: 'CANCELLED' },
                { where: { id: condition.signature_document_id } }
            ).catch(() => {});
        }

        const { note } = req.body;
        const newHistory = addHistory(condition.approval_history, 'unlocked', req, note || null);

        await condition.update({
            status: 'draft',
            unlocked_at: new Date(),
            unlocked_by: req.user?.id,
            signature_document_id: null,
            approved_at: null,
            approval_history: newHistory,
            updated_by: req.user?.id,
        });

        return res.json({ ok: true, status: 'draft' });
    } catch (e) {
        console.error('[conditions] unlockCondition:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// ─── módulos ─────────────────────────────────────────────────────────────────

export const upsertModules = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores podem editar módulos.' });

        const { id } = req.params;
        const { modules } = req.body;

        const condition = await EnterpriseCondition.findByPk(id);
        if (!condition) return res.status(404).json({ error: 'Ficha não encontrada.' });
        if (condition.status === 'approved') {
            return res.status(409).json({ error: 'Ficha aprovada está bloqueada.' });
        }

        // Validação de regras de negócio em todos os módulos
        const allErrors = [];
        for (const mod of modules) {
            allErrors.push(...validateModuleRules(mod));
        }
        if (allErrors.length) {
            return res.status(422).json({ error: allErrors[0], errors: allErrors });
        }

        // Identifica módulos novos para histórico
        const existingModules = await EnterpriseConditionModule.findAll({
            where: { condition_id: id },
            attributes: ['id', 'module_name'],
        });
        const existingIdSet = new Set(existingModules.map(m => String(m.id)));
        const newModuleNames = modules
            .filter(m => !m.id || !existingIdSet.has(String(m.id)))
            .map(m => m.module_name || 'Sem nome');

        // Operação atômica: módulos + campanhas na mesma transação
        await sequelize.transaction(async (t) => {
            for (const mod of modules) {
                const { campaigns, ...moduleFields } = mod;
                let savedModule;

                if (moduleFields.id) {
                    // Busca instância real — instance.update() é mais confiável que Model.update() estático
                    const existing = await EnterpriseConditionModule.findByPk(moduleFields.id, { transaction: t });
                    if (!existing || String(existing.condition_id) !== String(id)) {
                        throw new Error(`Módulo #${moduleFields.id} não encontrado ou não pertence a esta ficha.`);
                    }

                    // Remove chaves que não devem ser sobrescritas via update
                    const safeFields = { ...moduleFields };
                    ['id', 'condition_id', 'createdAt', 'updatedAt', 'created_at', 'updated_at'].forEach(k => delete safeFields[k]);

                    // Proteção explícita de idetapa: nunca sobrescrever valor existente com null
                    if ((safeFields.idetapa == null) && existing.idetapa != null) {
                        safeFields.idetapa = existing.idetapa;
                    }

                    await existing.update(safeFields, { transaction: t });
                    savedModule = existing;
                } else {
                    savedModule = await EnterpriseConditionModule.create(
                        { ...moduleFields, condition_id: Number(id) },
                        { transaction: t }
                    );
                }

                // Full-replace de campanhas do módulo
                if (Array.isArray(campaigns)) {
                    await EnterpriseConditionCampaign.destroy({
                        where: { module_id: savedModule.id },
                        transaction: t,
                    });

                    if (campaigns.length) {
                        await EnterpriseConditionCampaign.bulkCreate(
                            campaigns.map(({ id: _id, condition_id: _cid, module_id: _mid, createdAt: _cr, updatedAt: _up, ...rest }, i) => ({
                                ...rest,
                                condition_id: Number(id),
                                module_id: savedModule.id,
                                sort_order: rest.sort_order ?? i,
                            })),
                            { transaction: t }
                        );
                    }
                }
            }
        });

        // Registra módulos adicionados no histórico da ficha
        if (newModuleNames.length) {
            const fresh = await EnterpriseCondition.findByPk(id);
            const note = `Módulo(s) adicionado(s): ${newModuleNames.join(', ')}`;
            await fresh.update({
                approval_history: addHistory(fresh.approval_history, 'modules_updated', req, note),
                updated_by: req.user?.id,
            });
        }

        // Retorna módulos com campaigns incluídos
        const updatedModules = await EnterpriseConditionModule.findAll({
            where: { condition_id: id },
            order: [['sort_order', 'ASC']],
            include: [{ model: EnterpriseConditionCampaign, as: 'campaigns', separate: true, order: [['sort_order', 'ASC']] }],
        });

        return res.json({ ok: true, modules: updatedModules });
    } catch (e) {
        console.error('[conditions] upsertModules:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

export const deleteModule = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores podem excluir módulos.' });

        const { id, moduleId } = req.params;

        const condition = await EnterpriseCondition.findByPk(id);
        if (!condition) return res.status(404).json({ error: 'Ficha não encontrada.' });
        if (condition.status === 'approved') {
            return res.status(409).json({ error: 'Ficha aprovada está bloqueada.' });
        }

        const mod = await EnterpriseConditionModule.findOne({ where: { id: moduleId, condition_id: id } });
        if (!mod) return res.status(404).json({ error: 'Módulo não encontrado.' });

        await EnterpriseConditionCampaign.destroy({ where: { module_id: moduleId } });
        await mod.destroy();

        const note = `Módulo "${mod.module_name || `#${moduleId}`}" removido`;
        const newHistory = addHistory(condition.approval_history, 'modules_updated', req, note);
        await condition.update({ approval_history: newHistory, updated_by: req.user?.id });

        return res.json({ ok: true });
    } catch (e) {
        console.error('[conditions] deleteModule:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

export const copyModule = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores podem copiar módulos.' });

        const { id, moduleId, sourceId } = req.params;

        const source = await EnterpriseConditionModule.findOne({ where: { id: sourceId, condition_id: id } });
        if (!source) return res.status(404).json({ error: 'Módulo de origem não encontrado.' });

        const target = await EnterpriseConditionModule.findOne({ where: { id: moduleId, condition_id: id } });
        if (!target) return res.status(404).json({ error: 'Módulo destino não encontrado.' });

        const { id: _id, condition_id: _cid, idetapa, module_name, sort_order, ...copyFields } = source.toJSON();
        await target.update(copyFields);

        return res.json({ ok: true });
    } catch (e) {
        console.error('[conditions] copyModule:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// ─── Copiar módulo de outra ficha/empreendimento ──────────────────────────────

export const copyModuleFromSource = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores podem copiar módulos.' });

        const { id, moduleId, sourceConditionId, sourceModuleId } = req.params;
        const { fields } = req.body; // array de seções a copiar: ['negotiation','operational','campaigns','prices']

        // Verifica ficha destino
        const targetCondition = await EnterpriseCondition.findByPk(id);
        if (!targetCondition) return res.status(404).json({ error: 'Ficha destino não encontrada.' });
        if (targetCondition.status === 'approved') {
            return res.status(409).json({ error: 'Ficha aprovada está bloqueada.' });
        }

        // Verifica módulo destino
        const targetModule = await EnterpriseConditionModule.findOne({ where: { id: moduleId, condition_id: id } });
        if (!targetModule) return res.status(404).json({ error: 'Módulo destino não encontrado.' });

        // Verifica ficha e módulo de origem
        const sourceCondition = await EnterpriseCondition.findByPk(sourceConditionId, {
            include: [{ model: CvEnterprise, as: 'enterprise', attributes: ['nome'] }],
        });
        if (!sourceCondition) return res.status(404).json({ error: 'Ficha de origem não encontrada.' });

        const sourceModule = await EnterpriseConditionModule.findOne({
            where: { id: sourceModuleId, condition_id: sourceConditionId },
            include: [{ model: EnterpriseConditionCampaign, as: 'campaigns', order: [['sort_order', 'ASC']] }],
        });
        if (!sourceModule) return res.status(404).json({ error: 'Módulo de origem não encontrado.' });

        const src = sourceModule.toJSON();
        const updatePayload = {};

        const wantAll = !fields || !Array.isArray(fields) || fields.length === 0;
        const want = (section) => wantAll || fields.includes(section);

        // Campos de negociação
        const NEGOTIATION_FIELDS = [
            'max_entry_value', 'rp_installment_value', 'act_installment_value', 'min_installment_value',
            'max_installments', 'rp_rule', 'installment_until_habite_se', 'installment_post_habite_se',
            'has_state_subsidy', 'state_subsidy_note', 'state_subsidy_state', 'state_subsidy_program',
            'state_subsidy_custom_state', 'state_subsidy_rules', 'state_subsidy_conditions',
        ];
        // Campos de preços
        const PRICE_FIELDS = ['price_table_ids', 'manual_price_tables', 'price_premise_note'];
        // Campos operacionais
        const OPERATIONAL_FIELDS = [
            'manager_user_id', 'delivery_deadline_months', 'delivery_deadline_note',
            'commission_pct', 'commission_source', 'contract_registration_by',
            'contract_registered_by_user_id', 'outros_contact_name', 'outros_contact_email',
            'outros_contact_phone', 'cca_company_name', 'cca_cost', 'cca_charges_company',
            'correspondent_id', 'has_digital_cert', 'digital_cert_provider', 'digital_cert_contact',
            'notes',
        ];

        if (want('negotiation')) {
            for (const f of NEGOTIATION_FIELDS) {
                if (src[f] !== undefined) updatePayload[f] = src[f];
            }
        }
        if (want('prices')) {
            for (const f of PRICE_FIELDS) {
                if (src[f] !== undefined) updatePayload[f] = src[f];
            }
        }
        if (want('operational')) {
            for (const f of OPERATIONAL_FIELDS) {
                if (src[f] !== undefined) updatePayload[f] = src[f];
            }
        }

        if (Object.keys(updatePayload).length) {
            await targetModule.update(updatePayload);
        }

        // Copia campanhas
        if (want('campaigns') && src.campaigns?.length) {
            await EnterpriseConditionCampaign.destroy({ where: { module_id: targetModule.id } });
            await EnterpriseConditionCampaign.bulkCreate(
                src.campaigns.map(({ id: _id, condition_id: _cid, module_id: _mid, createdAt: _cr, updatedAt: _up, ...rest }, i) => ({
                    ...rest,
                    condition_id: Number(id),
                    module_id: targetModule.id,
                    sort_order: rest.sort_order ?? i,
                }))
            );
        }

        // Registra no histórico da ficha destino
        const enterpriseName = sourceCondition.enterprise?.nome || `Empreendimento #${sourceCondition.idempreendimento}`;
        const monthLabel = sourceCondition.reference_month?.substring(0, 7);
        const note = `Módulo "${src.module_name}" copiado de ${enterpriseName} — ${monthLabel}`;
        const newHistory = addHistory(targetCondition.approval_history, 'module_copied', req, note);
        await targetCondition.update({ approval_history: newHistory, updated_by: req.user?.id });

        return res.json({ ok: true, note });
    } catch (e) {
        console.error('[conditions] copyModuleFromSource:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// ─── Listar módulos por empreendimento ───────────────────────────────────────

export const getStagesForEnterprise = async (req, res) => {
    try {
        const { idempreendimento } = req.params;
        const stages = await CvEnterpriseStage.findAll({
            where: { idempreendimento: Number(idempreendimento) },
            attributes: ['idetapa', 'nome', 'idempreendimento'],
            order: [['idetapa', 'ASC']],
            include: [{
                model: CvEnterpriseBlock,
                as: 'blocos',
                attributes: ['idbloco', 'nome', 'total_unidades'],
                required: false,
            }],
        });

        const result = stages.map(s => {
            const json = s.toJSON();
            json.total_units = (json.blocos ?? []).reduce((sum, b) => sum + (b.total_unidades ?? 0), 0);
            return json;
        });

        return res.json(result);
    } catch (e) {
        console.error('[conditions] getStagesForEnterprise:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

export const getUnitsForStage = async (req, res) => {
    try {
        const { idetapa } = req.params;
        const blocks = await CvEnterpriseBlock.findAll({
            where: { idetapa: Number(idetapa) },
            attributes: ['idbloco', 'nome', 'total_unidades'],
            order: [['idbloco', 'ASC']],
            include: [{
                model: CvEnterpriseUnit,
                as: 'unidades',
                attributes: ['idunidade', 'nome', 'area_privativa', 'tipologia', 'situacao_mapa_disponibilidade', 'valor', 'valor_avaliacao'],
                required: false,
            }],
        });

        // Fallback: se unidades não estão na tabela, usa o raw do bloco
        const result = blocks.map(b => {
            const json = b.toJSON();
            if (!json.unidades?.length && b.raw?.unidades?.length) {
                json.unidades = b.raw.unidades.map(u => ({
                    idunidade: u.idunidade,
                    nome: u.nome,
                    area_privativa: u.area_privativa,
                    tipologia: u.tipologia,
                    situacao_mapa_disponibilidade: u.situacao?.situacao_mapa_disponibilidade ?? 1,
                    valor: u.valor,
                    valor_avaliacao: u.valor_avaliacao,
                }));
            }
            return json;
        });

        return res.json(result);
    } catch (e) {
        console.error('[conditions] getUnitsForStage:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

export const listModulesForEnterprise = async (req, res) => {
    try {
        const { idempreendimento } = req.params;

        const where = { idempreendimento: Number(idempreendimento) };
        if (!isAdmin(req)) where.status = 'approved';

        const conditions = await EnterpriseCondition.findAll({
            where,
            attributes: ['id', 'reference_month', 'status'],
            order: [['reference_month', 'DESC']],
            include: [
                {
                    model: EnterpriseConditionModule,
                    as: 'modules',
                    attributes: ['id', 'module_name', 'sort_order'],
                    order: [['sort_order', 'ASC']],
                },
            ],
        });

        return res.json(conditions);
    } catch (e) {
        console.error('[conditions] listModulesForEnterprise:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// ─── campanhas (legado — nível da condition) ─────────────────────────────────

export const upsertCampaigns = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores podem editar campanhas.' });

        const { id } = req.params;
        const { campaigns, module_id } = req.body;

        const condition = await EnterpriseCondition.findByPk(id);
        if (!condition) return res.status(404).json({ error: 'Ficha não encontrada.' });
        if (condition.status === 'approved') {
            return res.status(409).json({ error: 'Ficha aprovada está bloqueada.' });
        }

        // Se module_id fornecido, substitui campanhas do módulo específico
        // Caso contrário, substitui campanhas sem module_id (legado nível condition)
        const whereDestroy = module_id
            ? { condition_id: Number(id), module_id: Number(module_id) }
            : { condition_id: Number(id), module_id: null };

        await EnterpriseConditionCampaign.destroy({ where: whereDestroy });

        const created = (campaigns ?? []).length
            ? await EnterpriseConditionCampaign.bulkCreate(
                (campaigns ?? []).map(({ id: _id, condition_id: _cid, createdAt: _cr, updatedAt: _up, ...rest }, i) => ({
                    ...rest,
                    condition_id: Number(id),
                    module_id: module_id ? Number(module_id) : (rest.module_id ?? null),
                    sort_order: rest.sort_order ?? i,
                }))
              )
            : [];

        return res.json({ ok: true, campaigns: created });
    } catch (e) {
        console.error('[conditions] upsertCampaigns:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

export const deleteCampaign = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores podem excluir campanhas.' });

        const { id, campaignId } = req.params;
        await EnterpriseConditionCampaign.destroy({ where: { id: campaignId, condition_id: id } });
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// ─── distribuição de preços ───────────────────────────────────────────────────

export const getPriceDistributionForEnterprise = async (req, res) => {
    try {
        const { idempreendimento } = req.params;
        const { idetapa } = req.query;

        const distribution = await getPriceDistribution(
            Number(idempreendimento),
            idetapa ? Number(idetapa) : null
        );

        return res.json(distribution);
    } catch (e) {
        console.error('[conditions] priceDistribution:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// ─── tabelas de preço disponíveis ─────────────────────────────────────────────

export const getPriceTablesForEnterprise = async (req, res) => {
    try {
        const { idempreendimento } = req.params;
        const today = new Date();

        const tables = await CvEnterprisePriceTable.findAll({
            where: { idempreendimento: Number(idempreendimento), ativo_painel: true },
            attributes: ['idtabela', 'nome', 'ativo_painel', 'aprovado', 'data_vigencia_de', 'data_vigencia_ate', 'porcentagem_comissao', 'maximo_parcelas', 'quantidade_parcelas_min', 'quantidade_parcelas_max', 'forma', 'juros_mes', 'raw'],
            order: [['data_vigencia_de', 'DESC']],
        });

        const result = tables.map(t => {
            const json = t.toJSON();
            const vigente = (
                (!t.data_vigencia_de || new Date(t.data_vigencia_de) <= today) &&
                (!t.data_vigencia_ate || new Date(t.data_vigencia_ate) >= today)
            );
            const unidades = json.raw?.unidades ?? [];
            const prices = unidades.map(u => u.valor_total).filter(v => v != null && v > 0);
            return {
                ...json,
                vigente,
                unidades,
                unit_count:  unidades.length,
                price_avg:   prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
                price_min:   prices.length ? Math.min(...prices) : null,
                price_max:   prices.length ? Math.max(...prices) : null,
                price_total: prices.length ? prices.reduce((a, b) => a + b, 0) : null,
                raw: undefined,
            };
        });

        return res.json(result);
    } catch (e) {
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// ─── correspondentes ─────────────────────────────────────────────────────────

export const listCorrespondents = async (req, res) => {
    try {
        const correspondents = await CvCorrespondent.findAll({
            where: { ativo_login: true },
            attributes: ['idusuario', 'idempresa', 'nome', 'email', 'telefone', 'celular', 'gerente'],
            order: [['nome', 'ASC']],
        });
        return res.json(correspondents);
    } catch (e) {
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

export const listCorrespondentCompanies = async (req, res) => {
    try {
        const rows = await CvCorrespondent.findAll({
            where: { ativo_login: true },
            attributes: ['idusuario', 'idempresa', 'nome', 'email', 'celular'],
            order: [['nome', 'ASC']],
        });

        const map = new Map();
        for (const r of rows) {
            if (!r.idempresa) continue;
            if (!map.has(r.idempresa)) map.set(r.idempresa, { idempresa: r.idempresa, users: [] });
            map.get(r.idempresa).users.push({ idusuario: r.idusuario, nome: r.nome, email: r.email, celular: r.celular });
        }

        return res.json([...map.values()].sort((a, b) => a.idempresa - b.idempresa));
    } catch (e) {
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

export const listOfficeUsers = async (req, res) => {
    try {
        if (!User) return res.json([]);
        const users = await User.findAll({
            where: { status: true },
            attributes: ['id', 'username', 'email', 'position', 'city'],
            order: [['username', 'ASC']],
        });
        return res.json(users);
    } catch (e) {
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// ─── configurações comerciais (aprovadores) ───────────────────────────────────

export const getSettings = async (req, res) => {
    try {
        let settings = await ComercialSettings.findOne({
            where: { id: 1 },
            include: [
                { model: User, as: 'approver1', attributes: ['id', 'username', 'email'] },
                { model: User, as: 'approver2', attributes: ['id', 'username', 'email'] },
            ],
        });

        if (!settings) {
            // Cria registro singleton vazio na primeira chamada
            settings = await ComercialSettings.create({ id: 1 });
        }

        return res.json(settings);
    } catch (e) {
        console.error('[conditions] getSettings:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

export const updateSettings = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores podem alterar configurações.' });

        const { approver_1_id, approver_2_id, auto_generate_conditions } = req.body;

        let settings = await ComercialSettings.findOne({ where: { id: 1 } });
        if (!settings) settings = await ComercialSettings.create({ id: 1 });

        await settings.update({
            approver_1_id: approver_1_id || null,
            approver_2_id: approver_2_id || null,
            ...(auto_generate_conditions !== undefined && { auto_generate_conditions }),
            updated_by: req.user?.id,
        });

        return res.json({ ok: true });
    } catch (e) {
        console.error('[conditions] updateSettings:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// ─── publicar (legado — mantido para compatibilidade, redireciona para submit) ─

export const publishCondition = async (req, res) => {
    return submitForApproval(req, res);
};

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
    User,
} = db;

// ─── helpers ─────────────────────────────────────────────────────────────────

function toMonth(dateStr) {
    // Aceita '2026-04' ou '2026-04-01' → retorna '2026-04-01'
    if (!dateStr) return null;
    if (/^\d{4}-\d{2}$/.test(dateStr)) return `${dateStr}-01`;
    return dateStr.substring(0, 10);
}

async function getUnitCountForStage(idetapa) {
    const blocks = await CvEnterpriseBlock.findAll({
        where: { idetapa },
        attributes: ['idbloco'],
    });
    if (!blocks.length) return 0;
    const blockIds = blocks.map(b => b.idbloco);
    return CvEnterpriseUnit.count({ where: { idbloco: blockIds } });
}

/**
 * Distribuição de preços das unidades de um empreendimento/etapa.
 * Agrupa unidades por faixa de valor e retorna os grupos mais relevantes.
 */
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

    // Agrupa por valor (arredonda para o milhar mais próximo para evitar micro-diferenças)
    const grouped = new Map();
    for (const u of units) {
        if (u.valor == null) continue;
        const v = Number(u.valor);
        const bucket = Math.round(v / 1000) * 1000; // agrupa por milhar
        if (!grouped.has(bucket)) {
            grouped.set(bucket, { value: bucket, exactValues: new Set(), count: 0, units: [] });
        }
        const g = grouped.get(bucket);
        g.exactValues.add(v);
        g.count++;
        g.units.push({ idunidade: u.idunidade, nome: u.nome, valor: v, tipologia: u.tipologia });
    }

    // Se todas unidades caem no mesmo milhar, tenta por centena
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

// ─── listagem ────────────────────────────────────────────────────────────────

export const listConditions = async (req, res) => {
    try {
        const { idempreendimento } = req.query;

        const where = {};
        if (idempreendimento) where.idempreendimento = Number(idempreendimento);

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

export const getCondition = async (req, res) => {
    try {
        const { id } = req.params;

        const condition = await EnterpriseCondition.findByPk(id, {
            include: [
                { model: CvEnterprise, as: 'enterprise', attributes: ['idempreendimento', 'nome', 'cidade', 'estado', 'segmento_nome', 'situacao_comercial_nome', 'logo', 'tipo_empreendimento_nome'] },
                { model: EnterpriseConditionModule, as: 'modules', order: [['sort_order', 'ASC']] },
                { model: EnterpriseConditionCampaign, as: 'campaigns', order: [['sort_order', 'ASC']] },
                { model: CvCorrespondent, as: 'correspondent', attributes: ['idusuario', 'idempresa', 'nome', 'telefone', 'celular', 'email'] },
            ],
        });

        if (!condition) return res.status(404).json({ error: 'Ficha não encontrada.' });

        // Tabelas de preço vinculadas à ficha
        let priceTables = [];
        if (condition.price_table_ids?.length) {
            priceTables = await CvEnterprisePriceTable.findAll({
                where: { idtabela: condition.price_table_ids },
                attributes: ['idtabela', 'nome', 'ativo_painel', 'aprovado', 'data_vigencia_de', 'data_vigencia_ate', 'porcentagem_comissao', 'maximo_parcelas', 'forma'],
            });
        }

        return res.json({ ...condition.toJSON(), priceTables });
    } catch (e) {
        console.error('[conditions] getCondition:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// ─── criação ─────────────────────────────────────────────────────────────────

export const createCondition = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { idempreendimento, reference_month, ...rest } = req.body;

        if (!idempreendimento || !reference_month) {
            return res.status(400).json({ error: 'idempreendimento e reference_month são obrigatórios.' });
        }

        const month = toMonth(reference_month);

        // Verifica duplicidade
        const existing = await EnterpriseCondition.findOne({ where: { idempreendimento, reference_month: month } });
        if (existing) {
            return res.status(409).json({ error: 'Já existe uma ficha para esse empreendimento nesse mês.' });
        }

        const condition = await EnterpriseCondition.create({
            idempreendimento,
            reference_month: month,
            ...rest,
            created_by: userId,
            updated_by: userId,
        });

        // Auto-cria módulos a partir das etapas do CV (se não fornecidos)
        if (!req.body.modules?.length) {
            const stages = await CvEnterpriseStage.findAll({
                where: { idempreendimento },
                order: [['idetapa', 'ASC']],
            });

            for (let i = 0; i < stages.length; i++) {
                const stage = stages[i];
                const totalUnits = await getUnitCountForStage(stage.idetapa);
                const minDemand = Math.ceil(totalUnits * 0.2);

                await EnterpriseConditionModule.create({
                    condition_id: condition.id,
                    idetapa: stage.idetapa,
                    module_name: stage.nome,
                    sort_order: i,
                    total_units: totalUnits,
                    min_demand: minDemand,
                });
            }
        }

        return res.status(201).json({ id: condition.id });
    } catch (e) {
        console.error('[conditions] createCondition:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// ─── atualização ─────────────────────────────────────────────────────────────

export const updateCondition = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.id;

        const condition = await EnterpriseCondition.findByPk(id);
        if (!condition) return res.status(404).json({ error: 'Ficha não encontrada.' });

        const { modules, campaigns, ...fields } = req.body;

        await condition.update({ ...fields, updated_by: userId });

        return res.json({ ok: true });
    } catch (e) {
        console.error('[conditions] updateCondition:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// ─── módulos ─────────────────────────────────────────────────────────────────

export const upsertModules = async (req, res) => {
    try {
        const { id } = req.params;
        const { modules } = req.body;

        const condition = await EnterpriseCondition.findByPk(id);
        if (!condition) return res.status(404).json({ error: 'Ficha não encontrada.' });

        for (const mod of modules) {
            if (mod.id) {
                await EnterpriseConditionModule.update(mod, { where: { id: mod.id, condition_id: id } });
            } else {
                await EnterpriseConditionModule.create({ ...mod, condition_id: Number(id) });
            }
        }

        return res.json({ ok: true });
    } catch (e) {
        console.error('[conditions] upsertModules:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

export const copyModule = async (req, res) => {
    try {
        const { id, moduleId, sourceId } = req.params;

        const source = await EnterpriseConditionModule.findOne({
            where: { id: sourceId, condition_id: id },
        });
        if (!source) return res.status(404).json({ error: 'Módulo de origem não encontrado.' });

        const target = await EnterpriseConditionModule.findOne({
            where: { id: moduleId, condition_id: id },
        });
        if (!target) return res.status(404).json({ error: 'Módulo destino não encontrado.' });

        const { id: _id, condition_id: _cid, idetapa, module_name, sort_order, ...copyFields } = source.toJSON();
        await target.update(copyFields);

        return res.json({ ok: true });
    } catch (e) {
        console.error('[conditions] copyModule:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// ─── campanhas ───────────────────────────────────────────────────────────────

export const upsertCampaigns = async (req, res) => {
    try {
        const { id } = req.params;
        const { campaigns } = req.body;

        const condition = await EnterpriseCondition.findByPk(id);
        if (!condition) return res.status(404).json({ error: 'Ficha não encontrada.' });

        for (const camp of campaigns) {
            if (camp.id) {
                await EnterpriseConditionCampaign.update(camp, { where: { id: camp.id, condition_id: id } });
            } else {
                await EnterpriseConditionCampaign.create({ ...camp, condition_id: Number(id) });
            }
        }

        return res.json({ ok: true });
    } catch (e) {
        console.error('[conditions] upsertCampaigns:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

export const deleteCampaign = async (req, res) => {
    try {
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
            where: {
                idempreendimento: Number(idempreendimento),
                ativo_painel: true,
            },
            attributes: ['idtabela', 'nome', 'ativo_painel', 'aprovado', 'data_vigencia_de', 'data_vigencia_ate', 'porcentagem_comissao', 'maximo_parcelas', 'quantidade_parcelas_min', 'quantidade_parcelas_max', 'forma'],
            order: [['data_vigencia_de', 'DESC']],
        });

        // Marca vigentes
        const result = tables.map(t => ({
            ...t.toJSON(),
            vigente: (
                (!t.data_vigencia_de || new Date(t.data_vigencia_de) <= today) &&
                (!t.data_vigencia_ate || new Date(t.data_vigencia_ate) >= today)
            ),
        }));

        return res.json(result);
    } catch (e) {
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// ─── correspondentes ─────────────────────────────────────────────────────────

export const listCorrespondents = async (req, res) => {
    try {
        // Retorna usuários correspondentes ativos; frontend agrupa por idempresa se quiser
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

// ─── empresas de correspondentes ─────────────────────────────────────────────

export const listCorrespondentCompanies = async (req, res) => {
    try {
        const rows = await CvCorrespondent.findAll({
            where: { ativo_login: true },
            attributes: ['idusuario', 'idempresa', 'nome', 'email', 'celular'],
            order: [['nome', 'ASC']],
        });

        // Agrupa por idempresa
        const map = new Map();
        for (const r of rows) {
            if (!r.idempresa) continue;
            if (!map.has(r.idempresa)) {
                map.set(r.idempresa, { idempresa: r.idempresa, users: [] });
            }
            map.get(r.idempresa).users.push({
                idusuario: r.idusuario,
                nome: r.nome,
                email: r.email,
                celular: r.celular,
            });
        }

        const companies = [...map.values()].sort((a, b) => a.idempresa - b.idempresa);
        return res.json(companies);
    } catch (e) {
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// ─── usuários do office ───────────────────────────────────────────────────────

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

// ─── publicar / rascunho ──────────────────────────────────────────────────────

export const publishCondition = async (req, res) => {
    try {
        const { id } = req.params;
        const condition = await EnterpriseCondition.findByPk(id);
        if (!condition) return res.status(404).json({ error: 'Ficha não encontrada.' });

        await condition.update({ status: 'published', updated_by: req.user?.id });
        return res.json({ ok: true, status: 'published' });
    } catch (e) {
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

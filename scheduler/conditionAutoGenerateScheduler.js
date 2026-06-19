// scheduler/conditionAutoGenerateScheduler.js
// Todo dia 1 de cada mês, gera automaticamente a ficha do mês corrente para cada
// "série" de fichas ATIVA — tanto as vinculadas a empreendimento (CV) quanto as
// avulsas (sem CV, agrupadas por series_id). A ficha nova herda módulos/campanhas/
// campos da última ficha da série e só NÃO é criada quando a última está encerrada
// (status 'closed' = cancelada). Rascunho, em autorização e autorizada geram normalmente.
//
// Também faz catch-up no startup do servidor (idempotente — se a ficha do mês já
// existe na série, pula), cobrindo o cenário em que o servidor estava fora do ar no dia 1.

import cron from 'node-cron';
import db from '../models/sequelize/index.js';

const {
    EnterpriseCondition,
    EnterpriseConditionModule,
    EnterpriseConditionCampaign,
    ComercialSettings,
    sequelize: dbSequelize,
} = db;

// Cron: 1h da manhã do dia 1 de todo mês
const AUTO_GENERATE_CRON = process.env.CONDITION_AUTO_GENERATE_CRON || '0 1 1 * *';

// ─── Campos não herdados na geração mensal ────────────────────────────────────
// Identidade da ficha (idempreendimento/display_name/series_id) é definida
// explicitamente por quem gera; o restante de controle/aprovação começa zerado.
// price_table_ids: tabelas do CV podem expirar/mudar entre meses — o frontend
// re-seleciona as vigentes na 1ª abertura. manual_price_tables SÃO herdadas.
const CONDITION_NO_INHERIT = new Set([
    'id', 'idempreendimento', 'display_name', 'series_id',
    'reference_month', 'status',
    'submitted_at', 'submitted_by', 'approved_at',
    'unlocked_at', 'unlocked_by',
    'approval_history', 'created_by', 'updated_by',
    'createdAt', 'updatedAt', 'created_at', 'updated_at',
    'price_table_ids',
]);

// unit_snapshot: congelado do mês anterior — o mês novo começa sem snapshot.
// price_table_ids: idem CONDITION_NO_INHERIT — frontend reseleciona vigentes.
const MODULE_NO_INHERIT = new Set([
    'id', 'condition_id', 'unit_snapshot',
    'createdAt', 'updatedAt', 'created_at', 'updated_at',
    'price_table_ids',
]);

const CAMPAIGN_NO_INHERIT = new Set([
    'id', 'condition_id', 'module_id',
    'createdAt', 'updatedAt', 'created_at', 'updated_at',
]);

function pickInherit(obj, blocked) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (!blocked.has(k)) out[k] = v;
    }
    return out;
}

// Include padrão para puxar a ficha mais recente com módulos+campanhas.
const LATEST_INCLUDE = [{
    model: EnterpriseConditionModule,
    as: 'modules',
    separate: true,
    order: [['sort_order', 'ASC']],
    include: [{ model: EnterpriseConditionCampaign, as: 'campaigns', separate: true, order: [['sort_order', 'ASC']] }],
}];

// Monta o payload da ficha nova herdando os campos da ficha origem.
function buildInheritedCondition(latest, targetMonth, identity) {
    const inheritedFields = pickInherit(latest.toJSON(), CONDITION_NO_INHERIT);
    return {
        ...inheritedFields,
        ...identity, // { idempreendimento, display_name, series_id }
        reference_month: targetMonth,
        status: 'draft',
        price_table_ids: [], // CV reseleciona vigentes na 1ª abertura
        approval_history: [{
            action: 'auto_created',
            user_id: null,
            username: 'Sistema',
            at: new Date().toISOString(),
            note: `Gerada automaticamente — herdada de ${String(latest.reference_month).substring(0, 7)} (tabelas do CV serão re-selecionadas no novo mês)`,
        }],
    };
}

// Replica módulos e campanhas da ficha origem para a ficha nova (dentro da transação).
async function cloneModulesAndCampaigns(latest, newCond, t) {
    for (const mod of (latest.modules ?? [])) {
        const modJson = typeof mod.toJSON === 'function' ? mod.toJSON() : mod;
        const modFields = pickInherit(modJson, MODULE_NO_INHERIT);
        const newMod = await EnterpriseConditionModule.create({
            ...modFields,
            condition_id: newCond.id,
            unit_snapshot: null, // sempre limpo na nova ficha
            price_table_ids: [], // CV reseleciona vigentes na 1ª abertura
        }, { transaction: t });

        for (const camp of (modJson.campaigns ?? [])) {
            const campFields = pickInherit(camp, CAMPAIGN_NO_INHERIT);
            await EnterpriseConditionCampaign.create({
                ...campFields,
                condition_id: newCond.id,
                module_id: newMod.id,
            }, { transaction: t });
        }
    }
}

// ─── Série COM CV (idempreendimento) ──────────────────────────────────────────
async function generateMonthlyForEnterprise(idempreendimento, targetMonth) {
    return await dbSequelize.transaction(async (t) => {
        const existsTarget = await EnterpriseCondition.findOne({
            where: { idempreendimento, reference_month: targetMonth },
            transaction: t,
        });
        if (existsTarget) return { status: 'skipped', reason: 'already_exists' };

        const latest = await EnterpriseCondition.findOne({
            where: { idempreendimento },
            include: LATEST_INCLUDE,
            order: [['reference_month', 'DESC']],
            transaction: t,
        });
        if (!latest) return { status: 'skipped', reason: 'no_source_ficha' };
        if (latest.status === 'closed') return { status: 'skipped', reason: 'closed' };

        const newCond = await EnterpriseCondition.create(
            buildInheritedCondition(latest, targetMonth, { idempreendimento, display_name: null, series_id: null }),
            { transaction: t }
        );
        await cloneModulesAndCampaigns(latest, newCond, t);

        return { status: 'created', sourceMonth: String(latest.reference_month).substring(0, 7) };
    });
}

// ─── Série SEM CV (avulsa, agrupada por series_id) ────────────────────────────
async function generateMonthlyForSeries(seriesId, targetMonth) {
    return await dbSequelize.transaction(async (t) => {
        const existsTarget = await EnterpriseCondition.findOne({
            where: { series_id: seriesId, reference_month: targetMonth },
            transaction: t,
        });
        if (existsTarget) return { status: 'skipped', reason: 'already_exists' };

        const latest = await EnterpriseCondition.findOne({
            where: { series_id: seriesId },
            include: LATEST_INCLUDE,
            order: [['reference_month', 'DESC'], ['id', 'DESC']],
            transaction: t,
        });
        if (!latest) return { status: 'skipped', reason: 'no_source_ficha' };
        if (latest.status === 'closed') return { status: 'skipped', reason: 'closed' };

        const newCond = await EnterpriseCondition.create(
            buildInheritedCondition(latest, targetMonth, {
                idempreendimento: null,
                display_name: latest.display_name,
                series_id: seriesId,
            }),
            { transaction: t }
        );
        await cloneModulesAndCampaigns(latest, newCond, t);

        return { status: 'created', sourceMonth: String(latest.reference_month).substring(0, 7) };
    });
}

// Backfill idempotente: dá series_id às avulsas antigas (sem series_id), agrupando
// por display_name para não duplicar cadeias criadas manualmente mês a mês.
// series_id = menor id do grupo (ficha "cabeça" da série).
async function backfillAvulsaSeries() {
    const orphans = await EnterpriseCondition.findAll({
        where: { idempreendimento: null, series_id: null },
        attributes: ['id', 'display_name'],
        order: [['id', 'ASC']],
    });
    if (!orphans.length) return 0;

    const headByName = new Map(); // display_name normalizado → menor id
    for (const o of orphans) {
        const key = (o.display_name || '').trim().toLowerCase();
        if (!headByName.has(key)) headByName.set(key, o.id);
    }

    let updated = 0;
    for (const o of orphans) {
        const key = (o.display_name || '').trim().toLowerCase();
        const seriesId = headByName.get(key);
        await EnterpriseCondition.update({ series_id: seriesId }, { where: { id: o.id } });
        updated++;
    }
    console.log(`📋 [ConditionAutoGenerate] Backfill de séries avulsas: ${updated} ficha(s) atualizada(s).`);
    return updated;
}

async function autoGenerateConditions() {
    console.log('📋 [ConditionAutoGenerate] Iniciando geração automática de fichas...');

    const settings = await ComercialSettings.findOne({ where: { id: 1 } }).catch(() => null);
    if (settings?.auto_generate_conditions === false) {
        console.log('📋 [ConditionAutoGenerate] Auto-geração desativada nas configurações — pulando.');
        return;
    }

    // Garante que avulsas antigas tenham series_id antes de evoluir.
    await backfillAvulsaSeries().catch(err =>
        console.error('[ConditionAutoGenerate] backfill falhou:', err.message));

    // Mês de referência = mês atual
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    const { Op } = db.Sequelize;

    // 1) Séries COM CV — empreendimentos com ao menos 1 ficha (qualquer status).
    const cvRows = await EnterpriseCondition.findAll({
        attributes: ['idempreendimento'],
        where: { idempreendimento: { [Op.not]: null } },
        group: ['idempreendimento'],
    });
    const enterpriseIds = [...new Set(cvRows.map(c => c.idempreendimento))].filter(Boolean);

    // 2) Séries SEM CV — avulsas agrupadas por series_id.
    const avulsaRows = await EnterpriseCondition.findAll({
        attributes: ['series_id'],
        where: { idempreendimento: null, series_id: { [Op.not]: null } },
        group: ['series_id'],
    });
    const seriesIds = [...new Set(avulsaRows.map(c => c.series_id))].filter(Boolean);

    if (!enterpriseIds.length && !seriesIds.length) {
        console.log('📋 [ConditionAutoGenerate] Nenhuma série de ficha encontrada.');
        return;
    }

    let created = 0, skipped = 0, closed = 0, errors = 0;
    const tally = (r) => {
        if (r.status === 'created') created++;
        else if (r.reason === 'closed') closed++;
        else skipped++;
    };

    for (const idempreendimento of enterpriseIds) {
        try {
            const r = await generateMonthlyForEnterprise(idempreendimento, currentMonth);
            tally(r);
            if (r.status === 'created') {
                console.log(`✅ [ConditionAutoGenerate] CV #${idempreendimento} — ${currentMonth} (herdada de ${r.sourceMonth})`);
            }
        } catch (err) {
            errors++;
            console.error(`❌ [ConditionAutoGenerate] Erro CV #${idempreendimento}:`, err.message);
        }
    }

    for (const seriesId of seriesIds) {
        try {
            const r = await generateMonthlyForSeries(seriesId, currentMonth);
            tally(r);
            if (r.status === 'created') {
                console.log(`✅ [ConditionAutoGenerate] Avulsa série #${seriesId} — ${currentMonth} (herdada de ${r.sourceMonth})`);
            }
        } catch (err) {
            errors++;
            console.error(`❌ [ConditionAutoGenerate] Erro avulsa série #${seriesId}:`, err.message);
        }
    }

    console.log(`📋 [ConditionAutoGenerate] Concluído — ${created} criada(s), ${skipped} já existiam, ${closed} encerradas, ${errors} erro(s).`);
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

class ConditionAutoGenerateScheduler {
    constructor() {
        this.generateTask = null;
    }

    start() {
        // Auto-geração mensal
        this.generateTask = cron.schedule(AUTO_GENERATE_CRON, async () => {
            await autoGenerateConditions().catch(console.error);
        });

        console.log(`✅ ConditionAutoGenerateScheduler: geração=${AUTO_GENERATE_CRON}`);

        // Catch-up no startup: garante que o mês corrente tem ficha em todas as
        // séries elegíveis (cobre o servidor fora do ar no dia 1). Idempotente.
        autoGenerateConditions().catch(err =>
            console.error('[ConditionAutoGenerate] catch-up startup falhou:', err)
        );
    }

    stop() {
        this.generateTask?.stop();
        console.log('⛔ ConditionAutoGenerateScheduler parado');
    }

    // Roda a geração uma única vez (catch-up manual), sem agendar cron.
    async runOnce() {
        return autoGenerateConditions();
    }
}

export default new ConditionAutoGenerateScheduler();

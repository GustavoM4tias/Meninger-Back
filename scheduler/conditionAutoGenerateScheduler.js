// scheduler/conditionAutoGenerateScheduler.js
// Todo dia 1 de cada mês, gera automaticamente fichas em rascunho para cada
// empreendimento que JÁ TENHA AO MENOS UMA FICHA (qualquer status, exceto closed).
// A ficha nova herda módulos/campanhas/campos manuais da última ficha do empreendimento.
//
// Também faz catch-up no startup do servidor (idempotente — se ficha do mês
// já existe, pula) e polling de SignatureDocuments para transicionar fichas de
// pending_approval → approved quando todos os aprovadores assinaram.

import cron from 'node-cron';
import db from '../models/sequelize/index.js';

const {
    EnterpriseCondition,
    EnterpriseConditionModule,
    EnterpriseConditionCampaign,
    ComercialSettings,
    SignatureDocument,
    sequelize: dbSequelize,
} = db;

// Cron: 1h da manhã do dia 1 de todo mês
const AUTO_GENERATE_CRON = process.env.CONDITION_AUTO_GENERATE_CRON || '0 1 1 * *';
// Polling de assinaturas: a cada 10 minutos
const SIGNATURE_POLL_CRON = process.env.CONDITION_SIGNATURE_POLL_CRON || '*/10 * * * *';

// ─── Auto-geração de fichas ───────────────────────────────────────────────────

async function getUnitCountForStage(idetapa) {
    const blocks = await CvEnterpriseBlock.findAll({ where: { idetapa }, attributes: ['idbloco'] });
    if (!blocks.length) return 0;
    return CvEnterpriseUnit.count({ where: { idbloco: blocks.map(b => b.idbloco) } });
}

// Campos do EnterpriseCondition que NÃO devem ser herdados na geração mensal.
// Tudo o que faz parte do fluxo de aprovação ou identifica unicamente a ficha mãe.
// price_table_ids: tabelas do CV podem expirar/mudar entre meses — autoSelectVigentes
// no frontend escolhe as vigentes do novo mês na primeira abertura.
// manual_price_tables: tabelas manuais SÃO herdadas (responsabilidade do admin).
const CONDITION_NO_INHERIT = new Set([
    'id', 'reference_month', 'status',
    'submitted_at', 'submitted_by', 'approved_at',
    'signature_document_id', 'unlocked_at', 'unlocked_by',
    'approval_history', 'created_by', 'updated_by',
    'createdAt', 'updatedAt', 'created_at', 'updated_at',
    'price_table_ids',
]);

// Campos do EnterpriseConditionModule que NÃO devem ser herdados.
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

/**
 * Para um empreendimento, cria a ficha do mês atual herdando da ficha mais
 * recente (qualquer status, exceto closed). Idempotente: se já existe ficha
 * do mês alvo, retorna sem fazer nada.
 */
async function generateMonthlyForEnterprise(idempreendimento, targetMonth) {
    return await dbSequelize.transaction(async (t) => {
        // Já existe ficha do mês alvo? skip.
        const existsTarget = await EnterpriseCondition.findOne({
            where: { idempreendimento, reference_month: targetMonth },
            transaction: t,
        });
        if (existsTarget) return { status: 'skipped', reason: 'already_exists' };

        // Acha a ficha mais recente do empreendimento (com módulos+campanhas)
        const latest = await EnterpriseCondition.findOne({
            where: { idempreendimento },
            include: [
                {
                    model: EnterpriseConditionModule,
                    as: 'modules',
                    separate: true,
                    order: [['sort_order', 'ASC']],
                    include: [{ model: EnterpriseConditionCampaign, as: 'campaigns', separate: true, order: [['sort_order', 'ASC']] }],
                },
            ],
            order: [['reference_month', 'DESC']],
            transaction: t,
        });

        if (!latest) return { status: 'skipped', reason: 'no_source_ficha' };
        if (latest.status === 'closed') return { status: 'skipped', reason: 'closed' };

        // 1) Cria a ficha herdando os campos do EnterpriseCondition pai
        const inheritedFields = pickInherit(latest.toJSON(), CONDITION_NO_INHERIT);
        const newCond = await EnterpriseCondition.create({
            ...inheritedFields,
            idempreendimento,
            reference_month: targetMonth,
            status: 'draft',
            // Tabelas do CV ficam vazias — autoSelectVigentes do frontend escolhe
            // as vigentes do novo mês quando admin abre a ficha pela 1ª vez.
            price_table_ids: [],
            approval_history: [{
                action: 'auto_created',
                user_id: null,
                username: 'Sistema',
                at: new Date().toISOString(),
                note: `Gerada automaticamente — herdada de ${String(latest.reference_month).substring(0, 7)} (tabelas do CV serão re-selecionadas no novo mês)`,
            }],
        }, { transaction: t });

        // 2) Para cada módulo da ficha origem, cria um módulo equivalente
        for (const mod of (latest.modules ?? [])) {
            const modJson = mod.toJSON();
            const modFields = pickInherit(modJson, MODULE_NO_INHERIT);
            const newMod = await EnterpriseConditionModule.create({
                ...modFields,
                condition_id: newCond.id,
                unit_snapshot: null, // sempre limpo na nova ficha
                price_table_ids: [], // CV reseleciona vigentes na 1ª abertura
            }, { transaction: t });

            // 3) Replica campanhas do módulo
            for (const camp of (modJson.campaigns ?? [])) {
                const campFields = pickInherit(camp, CAMPAIGN_NO_INHERIT);
                await EnterpriseConditionCampaign.create({
                    ...campFields,
                    condition_id: newCond.id,
                    module_id: newMod.id,
                }, { transaction: t });
            }
        }

        return { status: 'created', sourceMonth: String(latest.reference_month).substring(0, 7) };
    });
}

async function autoGenerateConditions() {
    console.log('📋 [ConditionAutoGenerate] Iniciando geração automática de fichas...');

    const settings = await ComercialSettings.findOne({ where: { id: 1 } }).catch(() => null);
    if (settings?.auto_generate_conditions === false) {
        console.log('📋 [ConditionAutoGenerate] Auto-geração desativada nas configurações — pulando.');
        return;
    }

    // Mês de referência = mês atual
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    // Empreendimentos com ao menos 1 ficha (qualquer status). O filtro de 'closed'
    // é feito DENTRO do generateMonthlyForEnterprise (que olha a ficha mais recente).
    // FICHAS AVULSAS (idempreendimento NULL) NÃO se auto-evoluem — admin cria manualmente.
    const { Op } = db.Sequelize;
    const allConditions = await EnterpriseCondition.findAll({
        attributes: ['idempreendimento'],
        where: { idempreendimento: { [Op.not]: null } },
        group: ['idempreendimento'],
    });
    const enterpriseIds = [...new Set(allConditions.map(c => c.idempreendimento))].filter(Boolean);

    if (!enterpriseIds.length) {
        console.log('📋 [ConditionAutoGenerate] Nenhum empreendimento com ficha encontrado.');
        return;
    }

    let created = 0;
    let skipped = 0;
    let closed = 0;
    let errors = 0;

    for (const idempreendimento of enterpriseIds) {
        try {
            const result = await generateMonthlyForEnterprise(idempreendimento, currentMonth);
            if (result.status === 'created') {
                created++;
                console.log(`✅ [ConditionAutoGenerate] #${idempreendimento} — ${currentMonth} (herdada de ${result.sourceMonth})`);
            } else if (result.reason === 'closed') {
                closed++;
            } else {
                skipped++;
            }
        } catch (err) {
            errors++;
            console.error(`❌ [ConditionAutoGenerate] Erro #${idempreendimento}:`, err.message);
        }
    }

    console.log(`📋 [ConditionAutoGenerate] Concluído — ${created} criada(s), ${skipped} já existiam, ${closed} encerradas, ${errors} erro(s).`);
}

// ─── Polling de assinaturas → transição para approved ────────────────────────

async function pollConditionSignatures() {
    if (!SignatureDocument) return;

    const { Op } = db.Sequelize;

    // Busca fichas aguardando aprovação com SignatureDocument vinculado
    const pending = await EnterpriseCondition.findAll({
        where: {
            status: 'pending_approval',
            signature_document_id: { [Op.not]: null },
        },
        attributes: ['id', 'signature_document_id', 'approval_history'],
    });

    if (!pending.length) return;

    console.log(`🔍 [ConditionSignaturePoll] ${pending.length} ficha(s) aguardando aprovação...`);

    for (const condition of pending) {
        try {
            const signDoc = await SignatureDocument.findByPk(condition.signature_document_id);
            if (!signDoc) continue;

            if (signDoc.status === 'SIGNED') {
                // Todos assinaram → aprova a ficha (WHERE atômico evita race condition)
                const newHistory = [
                    ...(condition.approval_history || []),
                    {
                        action: 'approved',
                        user_id: null,
                        username: 'Sistema',
                        at: new Date().toISOString(),
                        note: `Documento de assinatura #${signDoc.id} totalmente assinado`,
                    },
                ];

                const [count] = await EnterpriseCondition.update(
                    { status: 'approved', approved_at: signDoc.signed_at_final || new Date(), approval_history: newHistory },
                    { where: { id: condition.id, status: 'pending_approval' } }
                );

                if (count > 0) {
                    console.log(`✅ [ConditionSignaturePoll] Ficha #${condition.id} aprovada (doc #${signDoc.id})`);
                } else {
                    console.log(`⚠️ [ConditionSignaturePoll] Ficha #${condition.id} — status já mudou antes do update de aprovação (ignorado)`);
                }
            } else if (signDoc.status === 'REJECTED') {
                // Reprovado pelos aprovadores → volta para rascunho com action específica
                const newHistory = [
                    ...(condition.approval_history || []),
                    {
                        action: 'approval_rejected',
                        user_id: null,
                        username: 'Sistema',
                        at: new Date().toISOString(),
                        note: `Documento #${signDoc.id} foi reprovado por um dos aprovadores`,
                    },
                ];

                const [count] = await EnterpriseCondition.update(
                    { status: 'draft', signature_document_id: null, approval_history: newHistory },
                    { where: { id: condition.id, status: 'pending_approval' } }
                );

                if (count > 0) {
                    console.log(`❌ [ConditionSignaturePoll] Ficha #${condition.id} reprovada (doc #${signDoc.id})`);
                } else {
                    console.log(`⚠️ [ConditionSignaturePoll] Ficha #${condition.id} — status já mudou antes do update de reprovação (ignorado)`);
                }
            } else if (['CANCELLED', 'EXPIRED'].includes(signDoc.status)) {
                // Cancelado/expirado → volta para rascunho
                const newHistory = [
                    ...(condition.approval_history || []),
                    {
                        action: 'approval_cancelled',
                        user_id: null,
                        username: 'Sistema',
                        at: new Date().toISOString(),
                        note: `Documento #${signDoc.id} teve status: ${signDoc.status}`,
                    },
                ];

                const [count] = await EnterpriseCondition.update(
                    { status: 'draft', signature_document_id: null, approval_history: newHistory },
                    { where: { id: condition.id, status: 'pending_approval' } }
                );

                if (count > 0) {
                    console.log(`⚠️ [ConditionSignaturePoll] Ficha #${condition.id} voltou para rascunho (doc ${signDoc.status})`);
                } else {
                    console.log(`⚠️ [ConditionSignaturePoll] Ficha #${condition.id} — status já mudou antes do update de cancelamento (ignorado)`);
                }
            }
        } catch (err) {
            console.error(`❌ [ConditionSignaturePoll] Erro na ficha #${condition.id}:`, err.message);
        }
    }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

class ConditionAutoGenerateScheduler {
    constructor() {
        this.generateTask = null;
        this.pollTask = null;
    }

    start() {
        // Auto-geração mensal
        this.generateTask = cron.schedule(AUTO_GENERATE_CRON, async () => {
            await autoGenerateConditions().catch(console.error);
        });

        // Polling de assinaturas
        this.pollTask = cron.schedule(SIGNATURE_POLL_CRON, async () => {
            await pollConditionSignatures().catch(console.error);
        });

        console.log(`✅ ConditionAutoGenerateScheduler: geração=${AUTO_GENERATE_CRON} | polling=${SIGNATURE_POLL_CRON}`);

        // Catch-up no startup: garante que o mês corrente tem ficha em todos os
        // empreendimentos elegíveis (cobre cenários onde o servidor estava fora
        // do ar no dia 1 e o cron não disparou). Idempotente.
        autoGenerateConditions().catch(err =>
            console.error('[ConditionAutoGenerate] catch-up startup falhou:', err)
        );

        // Roda poll imediatamente ao iniciar
        pollConditionSignatures().catch(console.error);
    }

    stop() {
        this.generateTask?.stop();
        this.pollTask?.stop();
        console.log('⛔ ConditionAutoGenerateScheduler parado');
    }
}

export default new ConditionAutoGenerateScheduler();

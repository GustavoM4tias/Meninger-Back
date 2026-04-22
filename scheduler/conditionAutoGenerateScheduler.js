// scheduler/conditionAutoGenerateScheduler.js
// Todo dia 1 de cada mês, gera automaticamente fichas em rascunho para cada
// empreendimento que tenha uma ficha aprovada no mês anterior.
// Também faz polling de SignatureDocuments para transitionar fichas de
// pending_approval → approved quando todos os aprovadores assinaram.

import cron from 'node-cron';
import db from '../models/sequelize/index.js';

const { EnterpriseCondition, EnterpriseConditionModule, CvEnterpriseStage, CvEnterpriseBlock, CvEnterpriseUnit, ComercialSettings, SignatureDocument } = db;

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

async function autoGenerateConditions() {
    console.log('📋 [ConditionAutoGenerate] Iniciando geração automática de fichas...');

    const settings = await ComercialSettings.findOne({ where: { id: 1 } }).catch(() => null);
    if (settings?.auto_generate_conditions === false) {
        console.log('📋 [ConditionAutoGenerate] Auto-geração desativada nas configurações — pulando.');
        return;
    }

    // Mês de referência = mês atual (ex: se hoje é 01/05/2026 → referência = 2026-05-01)
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    // Busca todos os empreendimentos com pelo menos 1 ficha aprovada
    const { Op } = db.Sequelize;
    const approvedConditions = await EnterpriseCondition.findAll({
        where: { status: 'approved' },
        attributes: ['idempreendimento'],
        group: ['idempreendimento'],
    });

    const enterpriseIds = [...new Set(approvedConditions.map(c => c.idempreendimento))];
    if (!enterpriseIds.length) {
        console.log('📋 [ConditionAutoGenerate] Nenhum empreendimento com ficha aprovada encontrado.');
        return;
    }

    let created = 0;
    let skipped = 0;

    for (const idempreendimento of enterpriseIds) {
        try {
            // Verifica se já existe ficha para o mês atual
            const existing = await EnterpriseCondition.findOne({
                where: { idempreendimento, reference_month: currentMonth },
            });

            if (existing) {
                skipped++;
                continue;
            }

            // Cria ficha em rascunho
            const condition = await EnterpriseCondition.create({
                idempreendimento,
                reference_month: currentMonth,
                status: 'draft',
                approval_history: [{
                    action: 'auto_created',
                    user_id: null,
                    username: 'Sistema',
                    at: new Date().toISOString(),
                    note: 'Geração automática dia 1 do mês',
                }],
            });

            // Auto-cria módulos a partir das etapas
            const stages = await CvEnterpriseStage.findAll({
                where: { idempreendimento },
                order: [['idetapa', 'ASC']],
            });

            for (let i = 0; i < stages.length; i++) {
                const stage = stages[i];
                const totalUnits = await getUnitCountForStage(stage.idetapa);
                await EnterpriseConditionModule.create({
                    condition_id: condition.id,
                    idetapa: stage.idetapa,
                    module_name: stage.nome,
                    sort_order: i,
                    total_units: totalUnits,
                    min_demand: Math.ceil(totalUnits * 0.2),
                });
            }

            created++;
            console.log(`✅ [ConditionAutoGenerate] Ficha criada para empreendimento #${idempreendimento} — ${currentMonth}`);
        } catch (err) {
            console.error(`❌ [ConditionAutoGenerate] Erro ao criar ficha para #${idempreendimento}:`, err.message);
        }
    }

    console.log(`📋 [ConditionAutoGenerate] Concluído — ${created} criada(s), ${skipped} já existiam.`);
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

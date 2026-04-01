// scheduler/contractApprovalScheduler.js
// A cada 20 minutos atualiza a alçada de autorização (siengeContractApproval)
// de todos os contratos criados que ainda não foram aprovados/reprovados.

import cron from 'node-cron';
import db from '../models/sequelize/index.js';
import { pollContractStatus, pollMeasurementStatus, pollTituloStatus, stepRegisterBoleto } from '../services/sienge/PaymentFlowPipelineService.js';

const CRON_EXP = process.env.CONTRACT_APPROVAL_CRON || '*/20 * * * *';

async function checkContractApprovals() {
    if (process.env.PAYMENT_FLOW_ENABLED !== 'true') return; // desabilitado neste ambiente
    console.log('🔍 [ContractApproval] Verificando alçadas de aprovação...');
    const { Op } = db.Sequelize;
    const skipStatuses = { [Op.notIn]: ['cancelado', 'titulo_pago', 'aborted'] };

    // ── Contrato/Aditivo aguardando autorização ───────────────────────────────
    const pendingContracts = await db.PaymentLaunch.findAll({
        where: {
            pipelineStage: 'awaiting_authorization',
            status: skipStatuses,
            siengeDocumentId: { [Op.not]: null },
            siengeContractNumber: { [Op.not]: null },
        },
        attributes: ['id', 'siengeDocumentId', 'siengeContractNumber', 'siengeContractApproval', 'pipelineStage'],
    });

    if (pendingContracts.length) {
        console.log(`🔍 [ContractApproval] ${pendingContracts.length} contrato(s) aguardando autorização.`);
        for (const launch of pendingContracts) {
            try {
                const contract = await pollContractStatus(launch.id);
                if (!contract) {
                    console.log(`⚠️ [ContractApproval] #${launch.id}: contrato não encontrado no Sienge.`);
                    continue;
                }
                console.log(`✅ [ContractApproval] #${launch.id}: alçada = ${contract.statusApproval ?? '?'} | autorizado = ${contract.isAuthorized}`);
            } catch (err) {
                console.error(`❌ [ContractApproval] Erro no lançamento #${launch.id}:`, err.message);
            }
        }
    } else {
        console.log('🔍 [ContractApproval] Nenhum contrato aguardando aprovação.');
    }

    // ── Medição aguardando autorização ────────────────────────────────────────
    const pendingMeasurements = await db.PaymentLaunch.findAll({
        where: {
            pipelineStage: 'awaiting_measurement_authorization',
            status: skipStatuses,
            siengeMeasurementNumber: { [Op.not]: null },
        },
        attributes: ['id', 'siengeMeasurementNumber', 'siengeMeasurementApproval'],
    });

    if (pendingMeasurements.length) {
        console.log(`🔍 [ContractApproval] ${pendingMeasurements.length} medição(ões) aguardando autorização.`);
        for (const launch of pendingMeasurements) {
            try {
                const measurement = await pollMeasurementStatus(launch.id);
                if (!measurement) {
                    console.log(`⚠️ [ContractApproval] #${launch.id}: medição não encontrada no Sienge.`);
                    continue;
                }
                console.log(`✅ [ContractApproval] #${launch.id}: medição ${launch.siengeMeasurementNumber} | autorizado = ${measurement.authorized}`);
            } catch (err) {
                console.error(`❌ [ContractApproval] Erro na medição #${launch.id}:`, err.message);
            }
        }
    }

    // ── Título criado mas boleto ainda não registrado (retry automático) ──────
    const pendingBoleto = await db.PaymentLaunch.findAll({
        where: {
            pipelineStage: 'titulo_created',
            status: skipStatuses,
            siengeTituloNumber: { [Op.not]: null },
            boletoBarcode: { [Op.not]: null },
        },
        attributes: ['id', 'siengeTituloNumber', 'boletoBarcode', 'siengeTituloError'],
    });

    if (pendingBoleto.length) {
        console.log(`🔁 [ContractApproval] ${pendingBoleto.length} título(s) com boleto pendente de registro — retentando...`);
        for (const launch of pendingBoleto) {
            try {
                const result = await stepRegisterBoleto(launch.id);
                if (result.success) {
                    console.log(`✅ [ContractApproval] #${launch.id}: boleto registrado com sucesso na retenativa.`);
                } else {
                    console.warn(`⚠️ [ContractApproval] #${launch.id}: boleto não registrado (${result.reason || result.error}).`);
                }
            } catch (err) {
                console.error(`❌ [ContractApproval] Erro ao registrar boleto #${launch.id}:`, err.message);
            }
        }
    }

    // ── Título aguardando pagamento ────────────────────────────────────────────
    const pendingTitulos = await db.PaymentLaunch.findAll({
        where: {
            pipelineStage: 'awaiting_titulo_authorization',
            status: skipStatuses,
            siengeTituloNumber: { [Op.not]: null },
        },
        attributes: ['id', 'siengeTituloNumber', 'siengeTituloStatus'],
    });

    if (pendingTitulos.length) {
        console.log(`🔍 [ContractApproval] ${pendingTitulos.length} título(s) aguardando pagamento.`);
        for (const launch of pendingTitulos) {
            try {
                const bill = await pollTituloStatus(launch.id);
                if (!bill) {
                    console.log(`⚠️ [ContractApproval] #${launch.id}: título não encontrado no Sienge.`);
                    continue;
                }
                console.log(`✅ [ContractApproval] #${launch.id}: título #${launch.siengeTituloNumber} | status = ${bill.status}`);
            } catch (err) {
                console.error(`❌ [ContractApproval] Erro no título #${launch.id}:`, err.message);
            }
        }
    }
}

class ContractApprovalScheduler {
    constructor() {
        this.task = null;
    }

    start() {
        if (this.task) this.task.stop();
        this.task = cron.schedule(CRON_EXP, async () => {
            await checkContractApprovals();
        });
        console.log(`✅ ContractApprovalScheduler configurado: ${CRON_EXP}`);

        // Roda imediatamente ao iniciar
        checkContractApprovals().catch(console.error);
    }

    stop() {
        if (this.task) this.task.stop();
        console.log('⛔ ContractApprovalScheduler parado');
    }
}

export default new ContractApprovalScheduler();

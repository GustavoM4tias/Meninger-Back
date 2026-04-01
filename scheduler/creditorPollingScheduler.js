// scheduler/creditorPollingScheduler.js
// A cada 20 minutos busca lançamentos onde o fornecedor não foi encontrado
// e o email de solicitação de cadastro (RID) já foi enviado.
// Se o fornecedor for cadastrado, continua a esteira automaticamente.

import cron from 'node-cron';
import db from '../models/sequelize/index.js';
import { runFullPipeline } from '../services/sienge/PaymentFlowPipelineService.js';

const CRON_EXP = process.env.CREDITOR_POLLING_CRON || '*/20 * * * *'; // a cada 20 min

async function checkPendingCreditors() {
    console.log('🔍 [CreditorPolling] Verificando fornecedores aguardando cadastro...');

    const pending = await db.PaymentLaunch.findAll({
        where: {
            siengeCreditorStatus: 'not_found',
            ridEmailSent: true,
        },
        attributes: ['id', 'providerCnpj', 'providerName', 'createdBy'],
    });

    if (!pending.length) {
        console.log('🔍 [CreditorPolling] Nenhum lançamento aguardando.');
        return;
    }

    console.log(`🔍 [CreditorPolling] ${pending.length} lançamento(s) aguardando cadastro.`);

    for (const launch of pending) {
        try {
            console.log(`🔍 [CreditorPolling] Verificando lançamento #${launch.id} (${launch.providerCnpj})`);

            // runFullPipeline reusa toda a orquestração:
            // credor → contrato/aditivo → awaiting_authorization → (scheduler dispara medição)
            const result = await runFullPipeline(launch.id, launch.createdBy);

            if (result.stage === 'creditor_not_found') {
                console.log(`⏳ [CreditorPolling] #${launch.id}: fornecedor ainda não cadastrado.`);
            } else {
                console.log(`✅ [CreditorPolling] #${launch.id}: esteira avançou para "${result.stage}".`);
            }
        } catch (err) {
            console.error(`❌ [CreditorPolling] Erro no lançamento #${launch.id}:`, err.message);
        }
    }
}

class CreditorPollingScheduler {
    constructor() {
        this.task = null;
    }

    start() {
        if (this.task) this.task.stop();
        this.task = cron.schedule(CRON_EXP, async () => {
            await checkPendingCreditors();
        });
        console.log(`✅ CreditorPollingScheduler configurado: ${CRON_EXP}`);

        // Roda imediatamente ao iniciar (sem aguardar o primeiro ciclo)
        checkPendingCreditors().catch(console.error);
    }

    stop() {
        if (this.task) this.task.stop();
        console.log('⛔ CreditorPollingScheduler parado');
    }
}

export default new CreditorPollingScheduler();

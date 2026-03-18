// scheduler/contractApprovalScheduler.js
// A cada 30 minutos atualiza a alçada de autorização (siengeContractApproval)
// de todos os contratos criados que ainda não foram aprovados/reprovados.

import cron from 'node-cron';
import db from '../models/sequelize/index.js';
import { pollContractStatus } from '../services/sienge/PaymentFlowPipelineService.js';

const CRON_EXP = process.env.CONTRACT_APPROVAL_CRON || '*/30 * * * *';

async function checkContractApprovals() {
    console.log('🔍 [ContractApproval] Verificando alçadas de aprovação...');

    // Busca lançamentos com contrato criado/encontrado que ainda não foram aprovados ou reprovados
    const pending = await db.PaymentLaunch.findAll({
        where: {
            siengeContractStatus: ['found', 'created'],
            status: { [db.Sequelize.Op.notIn]: ['cancelado', 'titulo_pago'] },
            [db.Sequelize.Op.or]: [
                { siengeContractApproval: null },
                { siengeContractApproval: 'PENDING' },
            ],
        },
        attributes: ['id', 'siengeDocumentId', 'siengeContractNumber', 'siengeContractApproval'],
    });

    if (!pending.length) {
        console.log('🔍 [ContractApproval] Nenhum contrato aguardando aprovação.');
        return;
    }

    console.log(`🔍 [ContractApproval] ${pending.length} contrato(s) para verificar.`);

    for (const launch of pending) {
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

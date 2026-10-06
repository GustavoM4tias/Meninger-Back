// scheduler/contractApprovalScheduler.js
// A cada 20 minutos atualiza a alçada de autorização (siengeContractApproval)
// de todos os contratos criados que ainda não foram aprovados/reprovados.

import cron from 'node-cron';
import db from '../models/sequelize/index.js';
import { pollContractStatus, pollMeasurementStatus, pollTituloStatus, stepRegisterBoleto, isPermanentBoletoError } from '../services/sienge/PaymentFlowPipelineService.js';
import { stepRegisterPix, completarAnexos } from '../services/sienge/paymentFlow/modules/titulo.js';
import { recipeOfLaunch } from '../services/sienge/paymentFlow/shared.js';
import { consultarAutorizacoes, atualizarAutorizacao } from '../services/sienge/paymentFlow/tituloAutorizacao.js';

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

    // Linha digitável inválida (Sienge 400) não se resolve com retry: pula esses
    // títulos em silêncio (aguardam registro manual no Sienge, sinalizado no card) e
    // só retenta os que falharam por motivo transitório.
    const retriableBoleto = pendingBoleto.filter(l => !isPermanentBoletoError(l.siengeTituloError));
    if (retriableBoleto.length) {
        console.log(`🔁 [ContractApproval] ${retriableBoleto.length} título(s) com boleto pendente de registro — retentando...`);
        for (const launch of retriableBoleto) {
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

    // ── Título do RB sem PIX (ou com anexo/liberação pendente) - retry automático ──
    const pendingPix = await db.PaymentLaunch.findAll({
        where: {
            pipelineStage: 'titulo_created',
            status: skipStatuses,
            siengeTituloNumber: { [Op.not]: null },
            boletoBarcode: null,
        },
    });
    for (const launch of pendingPix) {
        try {
            const { receita } = await recipeOfLaunch(launch);
            if (receita.titulo.pagamento !== 'pix') continue;
            const r = await stepRegisterPix(launch.id, { titulo: launch.siengeTituloNumber, documento: receita.titulo.documento || launch.nfType });
            console.log(`${r?.ok ? '✅' : '⚠️ '} [ContractApproval] #${launch.id}: PIX do RB ${r?.ok ? 'concluído' : 'ainda pendente'}.`);
        } catch (err) {
            console.error(`❌ [ContractApproval] Erro no PIX #${launch.id}:`, err.message);
        }
    }

    // ── Título com pagamento mas sem anexo no Sienge: anexa e finaliza a liberação ──
    const semAnexo = await db.PaymentLaunch.findAll({
        where: {
            status: skipStatuses,
            siengeTituloNumber: { [Op.not]: null },
            [Op.and]: [
                { [Op.or]: [{ nfUrl: { [Op.not]: null } }, { boletoUrl: { [Op.not]: null } }] },
                // aguardando pagamento, ou título ainda sem boleto (a nota já entra);
                // título com boleto pendente é do retry do boleto, que anexa junto
                { [Op.or]: [
                    { pipelineStage: 'awaiting_titulo_authorization' },
                    { pipelineStage: 'titulo_created', boletoBarcode: null },
                ] },
            ],
        },
        attributes: ['id'],
    });
    for (const launch of semAnexo) {
        try {
            const r = await completarAnexos(launch.id);
            if (!r.jaTinha) console.log(`${r.ok ? '✅' : '⚠️ '} [ContractApproval] #${launch.id}: anexo ${r.ok ? `enviado (${r.anexados})` : `pendente: ${r.aviso || r.motivo}`}.`);
        } catch (err) {
            console.error(`❌ [ContractApproval] Erro no anexo #${launch.id}:`, err.message);
        }
    }

    // ── Autorização de pagamento dos títulos em aberto ─────────────────────────
    // Uma consulta só (API bulk-data; backup D-1 se ela falhar) para todos os
    // títulos ainda não pagos. Também alimenta o cache que o pollTituloStatus
    // usa logo abaixo, então não há uma chamada por lançamento.
    try {
        const abertos = await db.PaymentLaunch.findAll({
            where: {
                pipelineStage: ['titulo_created', 'awaiting_titulo_authorization'],
                status: skipStatuses,
                siengeTituloNumber: { [Op.not]: null },
            },
        });
        if (abertos.length) {
            const auts = await consultarAutorizacoes(abertos.map(l => l.siengeTituloNumber));
            for (const launch of abertos) {
                await atualizarAutorizacao(launch, auts.get(Number(launch.siengeTituloNumber)));
            }
        }
    } catch (err) {
        console.error('❌ [ContractApproval] Erro ao consultar autorização dos títulos:', err.message);
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

// Uma rodada por vez: boleto, PIX, anexo e liberação abrem o robô (minutos por
// lançamento); duas rodadas juntas gravariam o mesmo título em paralelo.
let rodando = false;
async function rodadaUnica() {
    if (rodando) { console.log('⏭️  [ContractApproval] rodada anterior ainda em andamento; pulando.'); return; }
    rodando = true;
    try { await checkContractApprovals(); }
    finally { rodando = false; }
}

class ContractApprovalScheduler {
    constructor() {
        this.task = null;
    }

    start() {
        if (this.task) this.task.stop();
        this.task = cron.schedule(CRON_EXP, async () => {
            await rodadaUnica();
        });
        console.log(`✅ ContractApprovalScheduler configurado: ${CRON_EXP}`);

        // Roda imediatamente ao iniciar
        rodadaUnica().catch(console.error);
    }

    stop() {
        if (this.task) this.task.stop();
        console.log('⛔ ContractApprovalScheduler parado');
    }
}

export default new ContractApprovalScheduler();

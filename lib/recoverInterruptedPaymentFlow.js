// lib/recoverInterruptedPaymentFlow.js
//
// Fluxo de Pagamento: lançamento que estava no MEIO de uma automação quando o
// servidor reiniciou (deploy no Railway) ficava preso para sempre em
// "Criando contrato..." - o Playwright morreu com o processo, ninguém grava o
// fim, e a tela não oferece Processar nesse estado. Foi o #79 em 01/10/2026
// (clicado às 11:14, deploy às 11:13 e 11:21).
//
// No boot nenhum robô está rodando, então tudo que está em etapa "rodando"
// vira "Interrompido" com o motivo escrito. Processar de novo é seguro: o
// runner reseta essas etapas (STUCK_STAGES) e a busca acha o que o robô tiver
// chegado a gravar no Sienge antes de cair.

import db from '../models/sequelize/index.js';

const RODANDO = [
    'searching_creditor', 'searching_contract', 'validating_items',
    'creating_contract', 'creating_additive', 'creating_measurement', 'creating_titulo',
];

export async function recoverInterruptedPaymentFlow() {
    try {
        const [rows] = await db.sequelize.query(
            `UPDATE payment_launches
                SET pipeline_stage = 'aborted',
                    status = 'erro',
                    sienge_contract_status = CASE WHEN sienge_contract_status = 'creating' THEN NULL ELSE sienge_contract_status END,
                    sienge_contract_error = 'O servidor reiniciou durante a automação (etapa ' || pipeline_stage || '). Confira no Sienge se algo ficou pela metade e clique em Processar.',
                    updated_at = NOW()
              WHERE pipeline_stage IN (:rodando)
          RETURNING id, sienge_contract_error`,
            { replacements: { rodando: RODANDO } },
        );
        for (const r of rows || []) console.warn(`⚠️  [PaymentFlow] #${r.id}: ${r.sienge_contract_error}`);
        if (rows?.length) console.log(`✅ [PaymentFlow] ${rows.length} lançamento(s) interrompido(s) pelo reinício marcados para reprocessar.`);
    } catch (err) {
        console.warn(`⚠️  [PaymentFlow] recuperação de interrompidos falhou: ${err.message}`);
    }
}

export default recoverInterruptedPaymentFlow;

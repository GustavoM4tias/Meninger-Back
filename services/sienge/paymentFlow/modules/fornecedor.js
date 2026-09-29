// services/sienge/paymentFlow/modules/fornecedor.js
//
// Módulo FORNECEDOR: acha o credor no Sienge pelo CNPJ/CPF do lançamento.
// Não achou -> o lançamento fica em "Credor não cadastrado" e a tela oferece
// a RID; o creditorPollingScheduler retoma sozinho quando o cadastro sai.

import { SiengeCreditorService } from '../../SiengeCreditorService.js';
import { loadLaunch, patch } from '../shared.js';

export async function stepFindCreditor(launchId) {
    const launch = await loadLaunch(launchId);

    await patch(launch, { pipelineStage: 'searching_creditor', status: 'fornecedor' });

    const cnpj = String(launch.providerCnpj || '').replace(/\D/g, '');
    if (!cnpj) {
        await patch(launch, { pipelineStage: 'creditor_not_found', siengeCreditorStatus: 'not_found' });
        return { found: false, reason: 'CNPJ/CPF não informado' };
    }

    let creditor;
    try {
        creditor = await SiengeCreditorService.findByDocument(cnpj);
    } catch (err) {
        await patch(launch, {
            pipelineStage: 'creditor_not_found',
            siengeCreditorStatus: 'not_found',
            status: 'erro',
            siengeContractError: `Erro ao buscar credor: ${err.message}`,
        });
        throw err;
    }

    if (!creditor) {
        // Mantém status 'fornecedor' — aguardando cadastro via RID
        await patch(launch, { pipelineStage: 'creditor_not_found', siengeCreditorStatus: 'not_found' });
        return { found: false, reason: 'Credor não encontrado no Sienge' };
    }

    await patch(launch, {
        pipelineStage: 'creditor_found',
        siengeCreditorStatus: 'found',
        siengeCreditorId: creditor.id,
        siengeCreditorName: creditor.name,
    });
    return { found: true, creditor };
}

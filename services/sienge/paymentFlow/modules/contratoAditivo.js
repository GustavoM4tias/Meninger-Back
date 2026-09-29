// services/sienge/paymentFlow/modules/contratoAditivo.js
//
// Módulo CONTRATO - aditivo: acrescenta a verba do lançamento a um contrato
// existente pelo Playwright. O aditivo nasce pendente; a autorização é
// acompanhada por contratoBusca.pollContractStatus, que dispara a Medição.

import { runPlaywrightAdditive } from '../../../../playwright/services/additiveService.js';
import { DEFAULT_BUILDING_UNIT } from '../../SiengeContractService.js';
import { loadLaunch, patch, resolveEnterpriseIds, getUserSiengeCredentials } from '../shared.js';

export async function stepCreateAdditive(launchId, userId = null) {
    const launch = await loadLaunch(launchId);
    if (!launch.siengeDocumentId || !launch.siengeContractNumber) {
        throw new Error('Execute stepFindContract primeiro.');
    }

    await patch(launch, {
        pipelineStage: 'creating_additive',
        status: 'aditivo',
        siengeContractError: null,
        siengeContractAuthorized: false,      // reseta autorização do ciclo anterior
        siengeContractAuthorizedAt: null,
    });

    const { erpId } = await resolveEnterpriseIds(launch);

    const budgetItemName = launch.budgetItem || null;
    const budgetItemCode = launch.budgetItemCode || null;
    const financialAccountNumber = launch.financialAccountNumber || null;

    if (!budgetItemCode && !budgetItemName) {
        const msg = `Lançamento ${launch.id} sem item de orçamento configurado.`;
        await patch(launch, {
            pipelineStage: 'additive_error',
            status: 'erro',
            siengeContractError: msg,
        });
        return { success: false, error: msg };
    }

    if (!financialAccountNumber) {
        const msg = `Lançamento ${launch.id} sem conta financeira configurada.`;
        await patch(launch, {
            pipelineStage: 'additive_error',
            status: 'erro',
            siengeContractError: msg,
        });
        return { success: false, error: msg };
    }

    const descricao = (
        launch.notes?.trim() ||
        `${launch.launchType} - ${launch.siengeCreditorName || launch.providerName || ''} - ${launch.enterpriseName || ''}`
    ).slice(0, 200);

    const credentials = await getUserSiengeCredentials(userId || launch.createdBy);

    const playwrightPayload = {
        documentType: launch.siengeDocumentId,
        contractNumber: String(launch.siengeContractNumber),
        obraCod: String(erpId || launch.enterpriseId || ''),
        unidade: String(DEFAULT_BUILDING_UNIT),
        descricao,
        itemOrcamento: budgetItemName,
        itemOrcamentoCode: String(budgetItemCode),
        contaFinanceira: String(financialAccountNumber),
        percentualAlocacao: String(launch.allocationPercentage || '100'),
        precoMO: String(launch.unitPrice || ''),
        credentials,
    };

    try {
        await runPlaywrightAdditive(playwrightPayload);

        await patch(launch, {
            pipelineStage: 'additive_created',
            status: 'aditivo',
            siengeContractError: null,
        });

        return { success: true };
    } catch (err) {
        const msg = err.message || 'Erro desconhecido no Playwright (aditivo)';
        const isCredentialsError = msg.startsWith('CREDENCIAIS_INVALIDAS:');
        await patch(launch, {
            pipelineStage: 'additive_error',
            status: 'erro',
            siengeContractError: msg,
            ...(isCredentialsError && { siengeCredentialsInvalid: true }),
        });
        return { success: false, error: msg };
    }
}

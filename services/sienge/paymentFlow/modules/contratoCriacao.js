// services/sienge/paymentFlow/modules/contratoCriacao.js
//
// Módulo CONTRATO - criação: cria o contrato no Sienge pelo Playwright. O
// contrato nasce pendente; o scheduler acompanha a autorização
// (contratoBusca.pollContractStatus) e dispara a Medição.

import db from '../../../../models/sequelize/index.js';
import {
    getLaunchDocument,
    DEFAULT_CONTRACT_TYPE,
    DEFAULT_BUILDING_UNIT,
} from '../../SiengeContractService.js';
import { runPlaywrightContract } from '../../../../playwright/services/contractService.js';
import {
    loadLaunch, patch, resolveEnterpriseIds, getUserSiengeCredentials, fmtDate, endOfYear,
} from '../shared.js';

export async function stepCreateContract(launchId, userId = null) {
    const launch = await loadLaunch(launchId);

    await patch(launch, {
        pipelineStage: 'creating_contract',
        siengeContractStatus: 'creating',
        siengeContractError: null,
    });

    const { erpId, companyId } = await resolveEnterpriseIds(launch);

    const launchType = launch.launchType;

    // Busca o tipo de documento do BD (LaunchTypeConfig) para garantir que
    // o código correto seja usado — evita cair no fallback hardcoded 'PCEF'.
    const ltConfig = await db.LaunchTypeConfig.findOne({
        where: { name: launchType, active: true },
        attributes: ['documento'],
    }).catch(() => null);
    const documentType = ltConfig?.documento || getLaunchDocument(launchType);

    const objeto = (
        launch.notes?.trim() ||
        `${launchType} - ${launch.siengeCreditorName || launch.providerName || ''} - ${launch.enterpriseName || ''}`
    ).slice(0, 200);

    const hoje = new Date().toISOString().slice(0, 4);
    const inicio = fmtDate(
        launch.contractStartDate ||
        launch.nfIssueDate ||
        new Date().toISOString().slice(0, 10)
    );
    const termino = fmtDate(
        launch.contractEndDate ||
        launch.boletoDueDate ||
        endOfYear(hoje)
    );

    const budgetItemName = launch.budgetItem || null;
    const budgetItemCode = launch.budgetItemCode || null;
    const financialAccountNumber = launch.financialAccountNumber || null;

    if (!budgetItemCode && !budgetItemName) {
        const msg = `Lançamento ${launch.id} sem item de orçamento configurado.`;
        await patch(launch, {
            pipelineStage: 'contract_error',
            siengeContractStatus: 'error',
            status: 'erro',
            siengeContractError: msg,
        });
        return { success: false, error: msg };
    }

    if (!financialAccountNumber) {
        const msg = `Lançamento ${launch.id} sem conta financeira configurada.`;
        await patch(launch, {
            pipelineStage: 'contract_error',
            siengeContractStatus: 'error',
            status: 'erro',
            siengeContractError: msg,
        });
        return { success: false, error: msg };
    }

    // Departamento configurado no tipo; fallback seguro
    let departmentId = '24';
    try {
        const typeConfig = await db.LaunchTypeConfig.findOne({
            where: { name: launch.launchType, active: true },
            attributes: ['departamentoId'],
        });
        if (typeConfig?.departamentoId) {
            departmentId = String(typeConfig.departamentoId);
        }
    } catch (_) {
        // mantém fallback
    }

    // Data real de vencimento do boleto, com fallback
    const dataVencimento = fmtDate(
        launch.boletoDueDate ||
        launch.contractEndDate ||
        ''
    );

    const credentials = await getUserSiengeCredentials(userId || launch.createdBy);

    const playwrightPayload = {
        documento: documentType,
        objeto,
        empresa: String(companyId || launch.companyId || '97'),
        fornecedor: String(launch.siengeCreditorId || ''),
        tipoContrato: DEFAULT_CONTRACT_TYPE,
        dataInicio: inicio,
        dataTermino: termino,
        obraCod: String(erpId || launch.enterpriseId || ''),
        unidade: DEFAULT_BUILDING_UNIT,

        // seleção real
        itemOrcamento: budgetItemName,
        itemOrcamentoCode: String(budgetItemCode),
        contaFinanceira: String(financialAccountNumber),

        percentualAlocacao: String(launch.allocationPercentage || '100'),
        precoMO: String(launch.unitPrice || ''),

        // previsão financeira
        departmentId,
        dataVencimento,
        percentualParcela: '100',

        credentials,
    };

    try {
        const result = await runPlaywrightContract(playwrightPayload);

        await patch(launch, {
            pipelineStage: 'contract_created',
            siengeContractStatus: 'created',
            siengeContractCreatedByAutomation: true,
            siengeDocumentId: result.documentId || documentType,
            siengeContractNumber: result.contractNumber || null,
            siengeContractApproval: 'PENDING',
            siengeContractAuthorized: false,
            siengeContractError: result.avisos?.length ? result.avisos.join(' ') : null,
        });

        return { success: true, ...result };
    } catch (err) {
        const msg = err.message || 'Erro desconhecido no Playwright';
        const isCredentialsError = msg.startsWith('CREDENCIAIS_INVALIDAS:');
        await patch(launch, {
            pipelineStage: 'contract_error',
            siengeContractStatus: 'error',
            status: 'erro',
            siengeContractError: msg,
            ...(isCredentialsError && { siengeCredentialsInvalid: true }),
        });
        return { success: false, error: msg };
    }
}

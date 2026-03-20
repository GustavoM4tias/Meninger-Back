// services/paymentFlow/PaymentFlowPipelineService.js
import db from '../../models/sequelize/index.js';
import { SiengeCreditorService } from '../sienge/SiengeCreditorService.js';
import {
    SiengeContractService,
    getLaunchDocument,
    DEFAULT_CONTRACT_TYPE,
    DEFAULT_BUILDING_UNIT, 
    getAccountIndex,
} from '../sienge/SiengeContractService.js';
import { EnterpriseResolverService } from '../sienge/EnterpriseResolverService.js';
import { SiengeBillsService } from '../sienge/SiengeBillsService.js';
import { runPlaywrightContract } from '../../playwright/services/contractService.js';
import { runPlaywrightAdditive } from '../../playwright/services/additiveService.js';
import { runPlaywrightMeasurement } from '../../playwright/services/measurementService.js';
import { decrypt } from '../../utils/encryption.js';

const Model = () => db.PaymentLaunch;

/** Busca e descriptografa as credenciais Sienge do usuário */
async function getUserSiengeCredentials(userId) {
    if (!userId) return {};
    try {
        const user = await db.User.findByPk(userId, {
            attributes: ['sienge_email', 'sienge_password'],
        });
        if (!user?.sienge_email || !user?.sienge_password) return {};
        const email = decrypt(user.sienge_email);
        const password = decrypt(user.sienge_password);
        if (!email || !password) return {};
        return { email, password };
    } catch {
        return {};
    }
}

async function patch(launch, data) {
    await launch.update(data);
    return launch;
}

// ── helpers de data ───────────────────────────────────────────────────────────
function fmtDate(iso) {
    if (!iso) return '';
    const [y, m, d] = String(iso).slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
}

function endOfYear(year) {
    return `${year || new Date().getFullYear()}-12-31`;
}

// ── Resolve enterpriseId / companyId do lançamento ───────────────────────────
async function resolveEnterpriseIds(launch) {
    // Se o lançamento já tem ambos, usa direto
    if (launch.enterpriseId && launch.companyId) {
        return { erpId: launch.enterpriseId, companyId: launch.companyId };
    }

    // Tenta buscar via enterprise_cities pelo enterpriseId salvo
    if (launch.enterpriseId) {
        const ec = await EnterpriseResolverService.getByErpId(launch.enterpriseId);
        if (ec) return { erpId: ec.erpId, companyId: ec.companyId };
    }

    // Tenta resolver pelo nome do empreendimento
    if (launch.enterpriseName) {
        const { best } = await EnterpriseResolverService.resolveByName(launch.enterpriseName);
        if (best) return { erpId: best.erpId, companyId: best.companyId };
    }

    return { erpId: null, companyId: launch.companyId || null };
}

// ── Etapa 1: Credor ───────────────────────────────────────────────────────────
export async function stepFindCreditor(launchId) {
    const launch = await Model().findByPk(launchId);
    if (!launch) throw new Error(`Lançamento ${launchId} não encontrado`);

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

// ── Etapa 2: Contrato ─────────────────────────────────────────────────────────
export async function stepFindContract(launchId) {
    const launch = await Model().findByPk(launchId);
    if (!launch) throw new Error(`Lançamento ${launchId} não encontrado`);
    if (!launch.siengeCreditorId) throw new Error('Execute stepFindCreditor primeiro.');

    await patch(launch, { pipelineStage: 'searching_contract', status: 'contrato' });

    const { erpId, companyId } = await resolveEnterpriseIds(launch);

    let contract;
    try {
        contract = await SiengeContractService.findBySupplierId(
            launch.siengeCreditorId,
            companyId,
            erpId   // buildingId — filtra por obra no servidor
        );
    } catch (err) {
        await patch(launch, {
            pipelineStage: 'contract_not_found',
            siengeContractStatus: 'error',
            status: 'erro',
            siengeContractError: err.message,
        });
        throw err;
    }

    if (!contract) {
        await patch(launch, { pipelineStage: 'contract_not_found', siengeContractStatus: 'not_found' });
        return { found: false };
    }

    await patch(launch, {
        pipelineStage: 'contract_found',
        siengeContractStatus: 'found',
        siengeDocumentId: contract.documentId,
        siengeContractNumber: contract.contractNumber,
        siengeContractApproval: contract.statusApproval,
        siengeContractAuthorized: contract.isAuthorized,
        siengeContractAuthLevel: contract.currentAuthorizationLevel || null,
        contractStartDate: contract.startDate || null,
        contractEndDate: contract.endDate || null,
        siengeContractRaw: contract,
    });
    return { found: true, contract };
}

// ── Etapa 3: Validar itens ────────────────────────────────────────────────────
export async function stepValidateItems(launchId) {
    const launch = await Model().findByPk(launchId);
    if (!launch) throw new Error(`Lançamento ${launchId} não encontrado`);
    if (!launch.siengeDocumentId || !launch.siengeContractNumber) {
        throw new Error('Execute stepFindContract primeiro.');
    }

    await patch(launch, { pipelineStage: 'validating_items' });

    const { erpId, companyId } = await resolveEnterpriseIds(launch);

    const result = await SiengeContractService.validateItems(
        launch.siengeDocumentId,
        launch.siengeContractNumber,
        erpId || launch.enterpriseId,
        DEFAULT_BUILDING_UNIT,
        launch.unitPrice
    );

    // ── Saldo insuficiente: verifica se já foi lançado/pago anteriormente ────
    if (!result.ok) {
        const billCheck = await SiengeBillsService.checkPreviousLaunch({
            creditorId: launch.siengeCreditorId,
            debtorId: companyId || launch.companyId,
            costCenterId: erpId || launch.enterpriseId,
            documentNumber: launch.nfNumber,
            amount: launch.unitPrice,
        });

        if (billCheck.status === 'cravado') {
            // Documento + valor batem → certamente já foi lançado antes
            await patch(launch, {
                pipelineStage: 'items_insufficient',
                status: 'erro',
                siengeItemsRaw: result.items,
                siengeItemBalanceOk: false,
                siengeItemBalanceAvailable: result.balanceAvailable,
                siengeContractError: [
                    `⚠️ Saldo insuficiente, mas este lançamento JÁ FOI REGISTRADO anteriormente.`,
                    `Título encontrado no Sienge: doc "${billCheck.bill.documentNumber}"`,
                    `Valor: R$ ${billCheck.bill.totalInvoiceAmount}`,
                    `Emissão: ${billCheck.bill.issueDate}`,
                    `Status: ${billCheck.bill.status}`,
                ].join(' | '),
            });
            return {
                ...result,
                ok: false,
                previousLaunch: { status: 'cravado', bill: billCheck.bill },
            };
        }

        if (billCheck.status === 'suspeito') {
            // Valor bate mas documento difere → alerta, não bloqueia
            const warningMsg = [
                `⚠️ Saldo insuficiente. Encontrado título com valor semelhante (possível lançamento anterior).`,
                `Doc no Sienge: "${billCheck.bill.documentNumber}"`,
                `Valor: R$ ${billCheck.bill.totalInvoiceAmount}`,
                `Emissão: ${billCheck.bill.issueDate}`,
                `Verifique se já foi pago antes de criar novo contrato.`,
            ].join(' | ');

            await patch(launch, {
                pipelineStage: 'items_insufficient',
                status: 'erro',
                siengeItemsRaw: result.items,
                siengeItemBalanceOk: false,
                siengeItemBalanceAvailable: result.balanceAvailable,
                siengeContractError: warningMsg,
            });
            return {
                ...result,
                ok: false,
                previousLaunch: { status: 'suspeito', bill: billCheck.bill },
            };
        }

        // Nenhum título encontrado → saldo genuinamente insuficiente
        await patch(launch, {
            pipelineStage: 'items_insufficient',
            status: 'erro',
            siengeItemsRaw: result.items,
            siengeItemBalanceOk: false,
            siengeItemBalanceAvailable: result.balanceAvailable,
            siengeContractError: result.error || 'Saldo insuficiente no contrato.',
        });
        return { ...result, ok: false, previousLaunch: { status: 'nenhum', bill: null } };
    }

    // Saldo OK
    await patch(launch, {
        pipelineStage: 'items_ok',
        siengeItemsRaw: result.items,
        siengeItemBalanceOk: true,
        siengeItemBalanceAvailable: result.balanceAvailable,
        siengeContractError: null,
    });
    await patch(launch, { pipelineStage: 'ready' });
    return { ...result, ok: true, previousLaunch: null };
}

// ── Etapa 4: Criar contrato via Playwright ────────────────────────────────────
export async function stepCreateContract(launchId, userId = null) {
    const launch = await Model().findByPk(launchId);
    if (!launch) throw new Error(`Lançamento ${launchId} não encontrado`);

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

    // Busca credenciais do usuário (descriptografadas)
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

        // credenciais Sienge do usuário
        credentials,
    };

    try {
        const result = await runPlaywrightContract(playwrightPayload);

        await patch(launch, {
            pipelineStage: 'contract_created',
            siengeContractStatus: 'created',
            siengeDocumentId: result.documentId || documentType,
            siengeContractNumber: result.contractNumber || null,
            siengeContractApproval: 'PENDING',
            siengeContractAuthorized: false,
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

// ── Etapa 5: Criar aditivo via Playwright ─────────────────────────────────────
export async function stepCreateAdditive(launchId, userId = null) {
    const launch = await Model().findByPk(launchId);
    if (!launch) throw new Error(`Lançamento ${launchId} não encontrado`);
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

    const { erpId, companyId } = await resolveEnterpriseIds(launch);

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

// ── Etapa 6: Criar medição via Playwright ─────────────────────────────────────
export async function stepCreateMeasurement(launchId, userId = null) {
    const launch = await Model().findByPk(launchId);
    if (!launch) throw new Error(`Lançamento ${launchId} não encontrado`);
    if (!launch.siengeDocumentId || !launch.siengeContractNumber) {
        throw new Error('Execute stepFindContract primeiro.');
    }

    await patch(launch, {
        pipelineStage: 'creating_measurement',
        status: 'medicao',
        siengeMeasurementError: null,
    });

    const { erpId } = await resolveEnterpriseIds(launch);

    // Data de vencimento = boletoDueDate formatado como DD/MM/YYYY
    const dataVencimento = fmtDate(launch.boletoDueDate || launch.contractEndDate || '');

    const credentials = await getUserSiengeCredentials(userId || launch.createdBy);

    const playwrightPayload = {
        documentType: launch.siengeDocumentId,
        contractNumber: String(launch.siengeContractNumber),
        obraCod: String(erpId || launch.enterpriseId || ''),
        dataVencimento,
        value: String(launch.unitPrice || ''),
        credentials,
    };

    try {
        const result = await runPlaywrightMeasurement(playwrightPayload);

        await patch(launch, {
            pipelineStage: 'measurement_created',
            siengeMeasurementNumber: result.measurementNumber || null,
            siengeMeasurementAuthorized: false,
            siengeMeasurementApproval: 'PENDING',
            siengeMeasurementError: null,
        });

        // Avança para aguardar autorização da medição
        await patch(launch, { pipelineStage: 'awaiting_measurement_authorization' });

        return { success: true, measurementNumber: result.measurementNumber };
    } catch (err) {
        const msg = err.message || 'Erro desconhecido no Playwright (medição)';
        const isCredentialsError = msg.startsWith('CREDENCIAIS_INVALIDAS:');
        await patch(launch, {
            pipelineStage: 'measurement_error',
            status: 'erro',
            siengeMeasurementError: msg,
            ...(isCredentialsError && { siengeCredentialsInvalid: true }),
        });
        return { success: false, error: msg };
    }
}

// ── Polling de autorização da medição ─────────────────────────────────────────
export async function pollMeasurementStatus(launchId) {
    const launch = await Model().findByPk(launchId);
    if (!launch?.siengeMeasurementNumber) return null;

    const { erpId } = await resolveEnterpriseIds(launch);
    const buildingId = erpId || launch.enterpriseId;
    if (!buildingId) return null;

    const measurement = await SiengeContractService.getMeasurement(
        launch.siengeDocumentId,
        launch.siengeContractNumber,
        buildingId,
        launch.siengeMeasurementNumber
    );
    if (!measurement) return null;

    const isAuthorized = measurement.authorized === true;
    const approval = measurement.statusApproval || null;

    await launch.update({
        siengeMeasurementAuthorized: isAuthorized,
        siengeMeasurementApproval: approval,
    });

    // Quando autorizada: fluxo concluído — pronto para geração de título
    if (isAuthorized && launch.pipelineStage === 'awaiting_measurement_authorization') {
        await launch.update({ pipelineStage: 'ready' });
    }

    return measurement;
}

// ── Polling de autorização do contrato/aditivo ────────────────────────────────
export async function pollContractStatus(launchId) {
    const launch = await Model().findByPk(launchId);
    if (!launch?.siengeDocumentId || !launch?.siengeContractNumber) return null;

    const contract = await SiengeContractService.getByIds(
        launch.siengeDocumentId,
        launch.siengeContractNumber
    );
    if (!contract) return null;

    await launch.update({
        siengeContractApproval: contract.statusApproval,
        siengeContractAuthorized: contract.isAuthorized,
        siengeContractAuthLevel: contract.currentAuthorizationLevel || null,
        siengeContractRaw: contract,
        contractStartDate: contract.startDate || launch.contractStartDate,
        contractEndDate: contract.endDate || launch.contractEndDate,
    });

    // Quando autorizado E ainda em awaiting_authorization → dispara medição automaticamente
    if (contract.isAuthorized && launch.pipelineStage === 'awaiting_authorization') {
        console.log(`🚀 [Pipeline] #${launchId}: contrato/aditivo autorizado — iniciando medição automaticamente...`);
        // Não await — roda em background para não bloquear o scheduler
        stepCreateMeasurement(launchId, launch.createdBy).catch(err =>
            console.error(`❌ [Pipeline] #${launchId}: falha ao criar medição automática: ${err.message}`)
        );
    }

    return contract;
}

// ── Pipeline completo ─────────────────────────────────────────────────────────
// Fluxo automático contínuo:
//   Tem contrato → Aditivo → awaiting_authorization → [scheduler] → Medição → awaiting_measurement_authorization
//   Sem contrato → Cria    → awaiting_authorization → [scheduler] → Medição → awaiting_measurement_authorization
export async function runFullPipeline(launchId, userId = null) {
    const creditorResult = await stepFindCreditor(launchId);

    if (!creditorResult.found) {
        const launch = await Model().findByPk(launchId, { attributes: ['ridEmailSent'] });
        if (launch?.ridEmailSent) {
            return { stage: 'creditor_not_found', awaitingRegistration: true, ...creditorResult };
        }
        return { stage: 'creditor_not_found', awaitingRegistration: false, ...creditorResult };
    }

    const contractResult = await stepFindContract(launchId);

    if (!contractResult.found) {
        // Sem contrato: cria contrato novo → aguarda autorização → scheduler dispara medição
        const createResult = await stepCreateContract(launchId, userId);
        if (!createResult.success) return { stage: 'contract_error', ...createResult };

        const launch = await Model().findByPk(launchId);
        await patch(launch, { pipelineStage: 'awaiting_authorization', status: 'contrato' });
        return { stage: 'awaiting_authorization', ...createResult };
    }

    // Contrato existente: cria aditivo → aguarda autorização → scheduler dispara medição
    const additiveResult = await stepCreateAdditive(launchId, userId);
    if (!additiveResult.success) return { stage: 'additive_error', ...additiveResult };

    const launch = await Model().findByPk(launchId);
    await patch(launch, { pipelineStage: 'awaiting_authorization', status: 'aditivo' });
    return { stage: 'awaiting_authorization', ...additiveResult };
}
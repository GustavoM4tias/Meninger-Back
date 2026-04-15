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
import { SiengeBillsService } from './SiengeBillsService.js';
import { runPlaywrightContract } from '../../playwright/services/contractService.js';
import { runPlaywrightAdditive } from '../../playwright/services/additiveService.js';
import { runPlaywrightMeasurement } from '../../playwright/services/measurementService.js';
import { runPlaywrightTitulo } from '../../playwright/services/tituloService.js';
import { decrypt } from '../../utils/encryption.js';
import axios from 'axios';

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

// ── Anexar arquivos do lançamento à medição criada ────────────────────────────
async function attachMeasurementFiles(launch, buildingId, measurementNumber) {
    // Coleta todos os arquivos disponíveis no lançamento
    const files = [];

    if (launch.nfUrl) {
        files.push({
            url: launch.nfUrl,
            filename: launch.nfFilename || 'nota-fiscal.pdf',
            description: `Nota Fiscal${launch.nfNumber ? ` #${launch.nfNumber}` : ''}`,
            mimeType: 'application/pdf',
        });
    }

    if (launch.boletoUrl) {
        files.push({
            url: launch.boletoUrl,
            filename: launch.boletoFilename || 'boleto.pdf',
            description: 'Boleto',
            mimeType: 'application/pdf',
        });
    }

    const extras = Array.isArray(launch.extraAttachments) ? launch.extraAttachments : [];
    extras.forEach((att, i) => {
        if (att?.url) {
            files.push({
                url: att.url,
                filename: att.filename || `anexo-extra-${i + 1}.pdf`,
                description: att.description || `Anexo Extra ${i + 1}`,
                mimeType: att.mimeType || 'application/pdf',
            });
        }
    });

    const results = [];
    for (const file of files) {
        try {
            const { data: buffer } = await axios.get(file.url, {
                responseType: 'arraybuffer',
                timeout: 30000,
            });

            await SiengeContractService.attachMeasurementFile({
                documentId: launch.siengeDocumentId,
                contractNumber: launch.siengeContractNumber,
                buildingId: Number(buildingId),
                measurementNumber: Number(measurementNumber),
                description: file.description,
                fileBuffer: Buffer.from(buffer),
                filename: file.filename,
                mimeType: file.mimeType,
            });

            console.log(`📎 [Pipeline] Anexo "${file.description}" enviado com sucesso`);
            results.push({ file: file.description, ok: true });
        } catch (err) {
            console.warn(`⚠️  [Pipeline] Falha ao anexar "${file.description}": ${err.message}`);
            results.push({ file: file.description, ok: false, error: err.message });
        }
    }

    return results;
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

    // ADIÇÃO: busca departamentoId configurado no banco; fallback seguro
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

    // ADIÇÃO: usa a data real de vencimento do boleto, com fallback
    const dataVencimento = fmtDate(
        launch.boletoDueDate ||
        launch.contractEndDate ||
        ''
    );

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

        // ADIÇÃO: previsão financeira
        departmentId,
        dataVencimento,
        percentualParcela: '100',

        // credenciais Sienge do usuário
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
        // Reseta campos anteriores para evitar dados obsoletos em reprocessamento
        siengeMeasurementNumber: null,
        siengeMeasurementAuthorized: false,
        siengeMeasurementApproval: null,
    });

    const { erpId } = await resolveEnterpriseIds(launch);

    // Data de vencimento = boletoDueDate formatado como DD/MM/YYYY
    const dataVencimento = fmtDate(launch.boletoDueDate || launch.contractEndDate || '');

    const credentials = await getUserSiengeCredentials(userId || launch.createdBy);

    // ── Selecionar o item correto do contrato para a medição ──────────────────
    // A API retorna os itens na mesma ordem exibida no grid do Playwright.
    // Itens com saldo > 0 = editáveis no grid; itens com saldo = 0 = readonly.
    // Estratégia: 1º match exato de saldo; 2º menor saldo suficiente; 3º primeiro com saldo.
    let targetRowIndex = 1;
    try {
        const targetValue = Number(launch.unitPrice) || 0;
        const buildingId = erpId || launch.enterpriseId;
        const { items } = await SiengeContractService.validateItems(
            launch.siengeDocumentId,
            launch.siengeContractNumber,
            buildingId,
            1,           // buildingUnitId COMERCIAL
            targetValue,
        );

        if (items.length > 0) {
            // Salva items brutos para auditoria
            await patch(launch, {
                siengeItemsRaw: items,
            });

            // Filtra apenas itens com saldo positivo (serão os editáveis no grid)
            const withBalance = items
                .map((item, i) => ({ ...item, _pos: i }))
                .filter(it => (it._balanceEstimate || 0) > 0.005);

            if (withBalance.length > 0) {
                // Prioridade 1: saldo exatamente igual ao valor alvo (tolerância 1 centavo)
                const exactMatch = withBalance.find(
                    it => Math.abs((it._balanceEstimate || 0) - targetValue) < 0.01,
                );
                // Prioridade 2: saldo ≥ valor alvo — escolhe o de menor saldo suficiente
                const sufficient = withBalance
                    .filter(it => (it._balanceEstimate || 0) >= targetValue - 0.005)
                    .sort((a, b) => (a._balanceEstimate || 0) - (b._balanceEstimate || 0));
                const chosen = exactMatch || sufficient[0] || withBalance[0];

                // posição 1-based dentro dos itens com saldo (= índice entre editáveis)
                targetRowIndex = withBalance.findIndex(it => it._pos === chosen._pos) + 1;

                await patch(launch, {
                    siengeItemBalanceOk: (chosen._balanceEstimate || 0) >= targetValue - 0.005,
                    siengeItemBalanceAvailable: chosen._balanceEstimate || 0,
                });

                console.log(
                    `🎯 [Pipeline] #${launchId}: item escolhido pos=${chosen._pos + 1}` +
                    ` | saldo=${(chosen._balanceEstimate || 0).toFixed(2)}` +
                    ` | targetRowIndex=${targetRowIndex}`,
                );
            }
        }
    } catch (err) {
        console.warn(`⚠️ [Pipeline] #${launchId}: seleção de item falhou, usando 1º editável. ${err.message}`);
    }

    const playwrightPayload = {
        documentType: launch.siengeDocumentId,
        contractNumber: String(launch.siengeContractNumber),
        obraCod: String(erpId || launch.enterpriseId || ''),
        dataVencimento,
        value: String(launch.unitPrice || ''),
        targetRowIndex,
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

        // Anexar arquivos do lançamento à medição (NF, boleto, extras)
        if (result.measurementNumber) {
            const attachResults = await attachMeasurementFiles(
                launch,
                erpId || launch.enterpriseId,
                result.measurementNumber
            ).catch(err => {
                console.warn(`⚠️  [Pipeline] #${launchId}: Erro geral ao anexar arquivos: ${err.message}`);
                return [];
            });
            const ok = attachResults.filter(r => r.ok).length;
            console.log(`📎 [Pipeline] #${launchId}: ${ok}/${attachResults.length} anexo(s) enviado(s) à medição #${result.measurementNumber}`);
        }

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

// ── Etapa 7: Criar título (liberação de medição) via Playwright ───────────────
export async function stepCreateTitulo(launchId, userId = null) {
    const launch = await Model().findByPk(launchId);
    if (!launch) throw new Error(`Lançamento ${launchId} não encontrado`);
    if (!launch.siengeMeasurementNumber) throw new Error('Medição não encontrada — execute stepCreateMeasurement primeiro.');

    await patch(launch, {
        pipelineStage: 'creating_titulo',
        status: 'titulo',
        siengeTituloError: null,
        // Reseta campos anteriores para evitar dados obsoletos em reprocessamento
        siengeTituloNumber: null,
        siengeTituloStatus: null,
    });

    const { erpId } = await resolveEnterpriseIds(launch);
    const credentials = await getUserSiengeCredentials(userId || launch.createdBy);

    // Busca departamentoId configurado no banco; fallback para '24' (Comercial)
    let departamento = '24';
    try {
        const typeConfig = await db.LaunchTypeConfig.findOne({ where: { name: launch.launchType } });
        if (typeConfig?.departamentoId) departamento = String(typeConfig.departamentoId);
    } catch (_) { /* segue com o fallback */ }

    const playwrightPayload = {
        documentType: launch.siengeDocumentId,
        contractNumber: String(launch.siengeContractNumber),
        measurementNumber: Number(launch.siengeMeasurementNumber),
        nfType: launch.nfType || 'NFS',
        nfNumber: launch.nfNumber || '',
        nfIssueDate: launch.nfIssueDate || '',
        boletoDueDate: launch.boletoDueDate || '',
        departamento,
        unitPrice: String(launch.unitPrice || ''),
        credentials,
    };

    try {
        const result = await runPlaywrightTitulo(playwrightPayload);

        await patch(launch, {
            pipelineStage: 'titulo_created',
            siengeTituloNumber: result.tituloNumber || null,
            siengeTituloError: null,
        });

        console.log(`✅ [Pipeline] #${launchId}: título #${result.tituloNumber} criado com sucesso`);

        // Registra boleto automaticamente em background
        if (result.tituloNumber) {
            stepRegisterBoleto(launchId).catch(err =>
                console.error(`❌ [Pipeline] #${launchId}: falha ao registrar boleto: ${err.message}`)
            );
        }

        return { success: true, tituloNumber: result.tituloNumber };
    } catch (err) {
        const msg = err.message || 'Erro desconhecido no Playwright (título)';
        const isCredentialsError = msg.startsWith('CREDENCIAIS_INVALIDAS:');
        await patch(launch, {
            pipelineStage: 'titulo_error',
            status: 'erro',
            siengeTituloError: msg,
            ...(isCredentialsError && { siengeCredentialsInvalid: true }),
        });
        return { success: false, error: msg };
    }
}

// ── Etapa 8: Registrar boleto na parcela do título ────────────────────────────
export async function stepRegisterBoleto(launchId) {
    const launch = await Model().findByPk(launchId);
    if (!launch?.siengeTituloNumber) return { success: false, reason: 'sem_titulo' };
    if (!launch.boletoBarcode) return { success: false, reason: 'sem_barcode' };

    try {
        const installments = await SiengeBillsService.getInstallments(launch.siengeTituloNumber);
        if (!installments.length) {
            console.warn(`⚠️  [Pipeline] #${launchId}: nenhuma parcela encontrada para título #${launch.siengeTituloNumber}`);
            return { success: false, reason: 'sem_parcelas' };
        }

        const installment = installments[0]; // título único → 1 parcela
        console.log(`[Pipeline] #${launchId}: parcela encontrada → ${JSON.stringify(installment)}`);

        // Sienge usa installmentNumber como id da parcela no path
        const installmentId = installment.installmentNumber ?? installment.indexId ?? 1;
        await SiengeBillsService.registerBoletoPayment(
            launch.siengeTituloNumber,
            installmentId,
            launch.boletoBarcode
        );

        await launch.update({ pipelineStage: 'awaiting_titulo_authorization' });
        console.log(`✅ [Pipeline] #${launchId}: boleto registrado na parcela #${installment.installmentNumber} do título #${launch.siengeTituloNumber}`);
        return { success: true, installmentNumber: installment.installmentNumber };
    } catch (err) {
        // Não bloqueia o fluxo — salva o erro no banco para visibilidade no frontend
        console.error(`❌ [Pipeline] #${launchId}: erro ao registrar boleto: ${err.message}`);
        try {
            const l = await Model().findByPk(launchId, { attributes: ['id', 'pipelineStage'] });
            // Só salva o erro se o stage ainda é titulo_created (não sobrescreve se já avançou)
            if (l?.pipelineStage === 'titulo_created') {
                await l.update({ siengeTituloError: `Erro ao registrar boleto: ${err.message}` });
            }
        } catch (_) { /* silencioso */ }
        return { success: false, error: err.message };
    }
}

// ── Polling de status do título ────────────────────────────────────────────────
export async function pollTituloStatus(launchId) {
    const launch = await Model().findByPk(launchId);
    if (!launch?.siengeTituloNumber) return null;

    const bill = await SiengeBillsService.getBill(launch.siengeTituloNumber);
    if (!bill) return null;

    // Fonte primária: situação das parcelas via GET /bills/{id}/installments
    const installments = await SiengeBillsService.getInstallments(launch.siengeTituloNumber);
    const isPaid = installments.length > 0
        && installments.every(i => i.situation === 'Totalmente paga');

    await launch.update({ siengeTituloStatus: bill.status || null });

    const situacoes = installments.map(i => i.situation).join(', ') || bill.status || '?';
    console.log(`🔍 [Pipeline] #${launchId}: título #${launch.siengeTituloNumber} | parcelas=[${situacoes}] | pago=${isPaid}`);

    if (isPaid && launch.pipelineStage === 'awaiting_titulo_authorization') {
        await launch.update({ pipelineStage: 'titulo_pago', status: 'titulo_pago' });
        console.log(`✅ [Pipeline] #${launchId}: título pago → titulo_pago`);
    }

    return bill;
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

    await launch.update({
        siengeMeasurementAuthorized: isAuthorized,
        // statusApproval: D=DISAPPROVED | A=APPROVED | null = aguardando
        siengeMeasurementApproval: measurement.statusApproval || null,
    });

    console.log(`🔍 [Pipeline] #${launchId}: medição #${launch.siengeMeasurementNumber} | authorized=${isAuthorized}`);

    // Quando autorizada: dispara criação de título automaticamente
    // Update atômico: apenas 1 chamada concurrent (scheduler vs pollNow) avança o stage
    if (isAuthorized && launch.pipelineStage === 'awaiting_measurement_authorization') {
        const [changed] = await Model().update(
            { pipelineStage: 'creating_titulo' },
            { where: { id: launchId, pipelineStage: 'awaiting_measurement_authorization' } }
        );
        if (changed > 0) {
            console.log(`🚀 [Pipeline] #${launchId}: medição autorizada → iniciando criação de título automaticamente...`);
            // Não await — roda em background para não bloquear o scheduler
            stepCreateTitulo(launchId, launch.createdBy).catch(err =>
                console.error(`❌ [Pipeline] #${launchId}: falha ao criar título automático: ${err.message}`)
            );
        } else {
            console.log(`ℹ️  [Pipeline] #${launchId}: título já iniciado por outra instância — ignorando.`);
        }
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
    // Update atômico: apenas 1 chamada concurrent (scheduler vs pollNow) avança o stage
    if (contract.isAuthorized && launch.pipelineStage === 'awaiting_authorization') {
        const [changed] = await Model().update(
            { pipelineStage: 'creating_measurement' },
            { where: { id: launchId, pipelineStage: 'awaiting_authorization' } }
        );
        if (changed > 0) {
            console.log(`🚀 [Pipeline] #${launchId}: contrato/aditivo autorizado — iniciando medição automaticamente...`);
            // Não await — roda em background para não bloquear o scheduler
            stepCreateMeasurement(launchId, launch.createdBy).catch(err =>
                console.error(`❌ [Pipeline] #${launchId}: falha ao criar medição automática: ${err.message}`)
            );
        } else {
            console.log(`ℹ️  [Pipeline] #${launchId}: medição já iniciada por outra instância — ignorando.`);
        }
    }

    return contract;
}

// ── Etapa 9: Atualizar boleto de um título já existente ───────────────────────
export async function stepUpdateBoleto(launchId, { boletoUrl, boletoPath, boletoFilename, boletoBarcode, boletoDueDate, boletoAmount }) {
    const launch = await Model().findByPk(launchId);
    if (!launch) throw new Error(`Lançamento ${launchId} não encontrado`);
    if (!launch.siengeTituloNumber) return { success: false, reason: 'sem_titulo' };
    if (!boletoBarcode) return { success: false, reason: 'sem_barcode' };
    if (!boletoUrl) return { success: false, reason: 'sem_url' };

    // 1. Atualiza dados do boleto no banco
    await launch.update({
        boletoUrl: boletoUrl,
        boletoPath: boletoPath || launch.boletoPath,
        boletoFilename: boletoFilename || launch.boletoFilename,
        boletoBarcode,
        boletoDueDate: boletoDueDate || launch.boletoDueDate,
        boletoAmount: boletoAmount || launch.boletoAmount,
        siengeTituloError: null,
    });

    // 2. Atualiza o código de barras na parcela do Sienge
    try {
        const installments = await SiengeBillsService.getInstallments(launch.siengeTituloNumber);
        if (!installments.length) throw new Error('Nenhuma parcela encontrada para o título');
        const installment = installments[0];
        const installmentId = installment.installmentNumber ?? installment.indexId ?? 1;
        await SiengeBillsService.registerBoletoPayment(launch.siengeTituloNumber, installmentId, boletoBarcode);
        console.log(`✅ [Pipeline] #${launchId}: barcode atualizado na parcela #${installmentId} do título #${launch.siengeTituloNumber}`);
    } catch (err) {
        console.error(`❌ [Pipeline] #${launchId}: falha ao atualizar barcode no Sienge: ${err.message}`);
        throw err; // propaga para o controller retornar 500 ao frontend
    }

    // 3. Anexa o novo arquivo de boleto ao título no Sienge (não-bloqueante)
    try {
        const { data: buffer } = await axios.get(boletoUrl, { responseType: 'arraybuffer', timeout: 30000 });
        const desc = `Boleto${boletoDueDate ? ` — Vence ${boletoDueDate}` : ''}`;
        await SiengeBillsService.attachBillFile(
            launch.siengeTituloNumber,
            desc,
            Buffer.from(buffer),
            boletoFilename || 'boleto.pdf'
        );
        console.log(`📎 [Pipeline] #${launchId}: novo boleto anexado ao título #${launch.siengeTituloNumber}`);
    } catch (err) {
        // Falha no anexo não deve travar o fluxo — barcode já foi atualizado
        console.warn(`⚠️  [Pipeline] #${launchId}: falha ao anexar boleto ao título (continuando): ${err.message}`);
    }

    // 4. Avança para aguardando pagamento (ou mantém se já estava lá)
    const refreshed = await Model().findByPk(launchId, { attributes: ['id', 'pipelineStage'] });
    if (!['awaiting_titulo_authorization', 'titulo_pago'].includes(refreshed?.pipelineStage)) {
        await refreshed.update({ pipelineStage: 'awaiting_titulo_authorization' });
    }

    console.log(`✅ [Pipeline] #${launchId}: boleto atualizado com sucesso no título #${launch.siengeTituloNumber}`);
    return { success: true };
}

// ── Pipeline completo ─────────────────────────────────────────────────────────
// Fluxo automático contínuo:
//   Tem contrato → Aditivo → awaiting_authorization → [scheduler] → Medição → awaiting_measurement_authorization
//   Sem contrato → Cria    → awaiting_authorization → [scheduler] → Medição → awaiting_measurement_authorization
// Estágios onde o Playwright pode ter travado — permite forçar reprocessamento
const STUCK_STAGES = ['creating_contract', 'creating_additive', 'creating_measurement', 'creating_titulo', 'contract_manual_block', 'aborted'];

export async function runFullPipeline(launchId, userId = null) {
    // Se travado em um estado creating_* ou contract_manual_block, reseta para idle antes de rodar
    const current = await Model().findByPk(launchId, { attributes: ['id', 'pipelineStage'] });
    const currentStage = current?.pipelineStage;

    // ── Retomada direta: não voltar atrás quando a etapa de medição ou título falhou ──
    if (currentStage === 'measurement_error') {
        console.log(`⏩ [Pipeline] #${launchId}: retomando da medição (stage: measurement_error)`);
        await current.update({ siengeMeasurementError: null });
        const result = await stepCreateMeasurement(launchId, userId);
        return { stage: result.success ? 'measurement_created' : 'measurement_error', ...result };
    }
    if (currentStage === 'titulo_error') {
        console.log(`⏩ [Pipeline] #${launchId}: retomando do título (stage: titulo_error)`);
        const result = await stepCreateTitulo(launchId, userId);
        return { stage: result.success ? 'titulo_created' : 'titulo_error', ...result };
    }

    // Captura se estava bloqueado manualmente ANTES de resetar o stage
    const bypassAutoCheck = currentStage === 'contract_manual_block';
    if (current && STUCK_STAGES.includes(currentStage)) {
        console.warn(`⚠️  [Pipeline] #${launchId}: stage "${currentStage}" travado — resetando para idle antes de reprocessar.`);
        await current.update({ pipelineStage: 'idle', siengeContractError: null });
    }

    const creditorResult = await stepFindCreditor(launchId);

    // Verifica abort entre etapas
    const afterCreditor = await Model().findByPk(launchId, { attributes: ['pipelineStage'] });
    if (afterCreditor?.pipelineStage === 'aborted') return { stage: 'aborted' };

    if (!creditorResult.found) {
        const launch = await Model().findByPk(launchId, { attributes: ['ridEmailSent'] });
        if (launch?.ridEmailSent) {
            return { stage: 'creditor_not_found', awaitingRegistration: true, ...creditorResult };
        }
        return { stage: 'creditor_not_found', awaitingRegistration: false, ...creditorResult };
    }

    const contractResult = await stepFindContract(launchId);

    // Verifica abort entre etapas
    const afterContract = await Model().findByPk(launchId, { attributes: ['pipelineStage'] });
    if (afterContract?.pipelineStage === 'aborted') return { stage: 'aborted' };

    if (!contractResult.found) {
        // Sem contrato: cria contrato novo → aguarda autorização → scheduler dispara medição
        const createResult = await stepCreateContract(launchId, userId);
        if (!createResult.success) return { stage: 'contract_error', ...createResult };

        const launch = await Model().findByPk(launchId);
        await patch(launch, { pipelineStage: 'awaiting_authorization', status: 'contrato' });
        return { stage: 'awaiting_authorization', ...createResult };
    }

    // Contrato existente: valida se foi criado pela automação antes de criar aditivo
    const launch = await Model().findByPk(launchId);

    // 1️⃣ O próprio lançamento teve o contrato criado pela automação (flag imutável)?
    //    Cobre: re-execuções do mesmo lançamento + override manual de contratos históricos.
    // 2️⃣ Fallback: outro lançamento no banco criou o mesmo contrato anteriormente.
    const { Op } = db.Sequelize;
    const AUTOMATION_STAGES = [
        'contract_created',
        'awaiting_authorization',
        'additive_created',
        'additive_error',
        'measurement_created',
        'awaiting_measurement_authorization',
        'creating_titulo',
        'titulo_created',
        'titulo_error',
        'awaiting_titulo_authorization',
        'titulo_pago',
        'ready',
    ];

    const selfCreated = launch.siengeContractCreatedByAutomation === true;
    const peerCreated = selfCreated ? null : await Model().findOne({
        where: {
            id: { [Op.ne]: launch.id },
            siengeDocumentId: launch.siengeDocumentId,
            siengeContractNumber: launch.siengeContractNumber,
            [Op.or]: [
                { siengeContractCreatedByAutomation: true },
                { siengeContractStatus: 'created' },
                { pipelineStage: { [Op.in]: AUTOMATION_STAGES } },
            ],
        },
    });

    const automationEvidence = selfCreated || peerCreated;

    if (!automationEvidence && !bypassAutoCheck) {
        // Contrato pré-existente (criado manualmente) — não cria aditivo automaticamente
        const msg = `Contrato ${launch.siengeDocumentId}/${launch.siengeContractNumber} encontrado no Sienge mas não foi criado pela automação. Requer verificação manual antes de prosseguir.`;
        await patch(launch, {
            pipelineStage: 'contract_manual_block',
            status: 'erro',
            siengeContractError: msg,
        });
        console.warn(`⚠️  [Pipeline] #${launchId}: ${msg}`);
        return { stage: 'contract_manual_block', blocked: true, error: msg };
    }

    if (!automationEvidence && bypassAutoCheck) {
        // Usuário confirmou que o contrato pré-existente é válido — marca como criado pela automação
        console.log(`✅ [Pipeline] #${launchId}: bypass do bloqueio manual — marcando contrato como criado pela automação.`);
        await patch(launch, { siengeContractCreatedByAutomation: true, siengeContractError: null });
    }

    // Contrato criado pela automação → cria aditivo → aguarda autorização → scheduler dispara medição
    const additiveResult = await stepCreateAdditive(launchId, userId);
    if (!additiveResult.success) return { stage: 'additive_error', ...additiveResult };

    await patch(launch, { pipelineStage: 'awaiting_authorization', status: 'aditivo' });
    return { stage: 'awaiting_authorization', ...additiveResult };
}

export async function continueExistingContractPipeline(launchId, userId = null) {
    const launch = await Model().findByPk(launchId);
    if (!launch) throw new Error(`Lançamento ${launchId} não encontrado`);

    if (!launch.siengeDocumentId || !launch.siengeContractNumber) {
        throw new Error('Contrato não encontrado para prosseguir.');
    }

    // Marca como criado pela automação para futuras re-execuções não bloquearem
    await patch(launch, { siengeContractCreatedByAutomation: true, siengeContractError: null });

    const additiveResult = await stepCreateAdditive(launchId, userId);
    if (!additiveResult.success) {
        return { stage: 'additive_error', ...additiveResult };
    }

    const refreshed = await Model().findByPk(launchId);
    await patch(refreshed, {
        pipelineStage: 'awaiting_authorization',
        status: 'aditivo',
        siengeContractError: null,
    });

    return { stage: 'awaiting_authorization', ...additiveResult };
}

export async function abortPipeline(launchId) {
    const launch = await Model().findByPk(launchId);
    if (!launch) throw new Error(`Lançamento ${launchId} não encontrado`);
    if (['titulo_pago', 'cancelado'].includes(launch.status)) {
        return { aborted: false, reason: 'already_finished' };
    }
    await launch.update({
        pipelineStage: 'aborted',
        status: 'erro',
        siengeContractError: 'Processo interrompido pelo usuário.',
    });
    console.log(`🛑 [Pipeline] #${launchId}: pipeline abortado pelo usuário.`);
    return { aborted: true };
}
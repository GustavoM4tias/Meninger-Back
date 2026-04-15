// playwright/services/contractService.js
import { siengeLogin } from "../modules/sienge/login.js";
import { createInitialContract } from "../modules/sienge/createContract.js";
import { itemsContract } from "../modules/sienge/itemsContract.js";
import { financialForecastContract } from "../modules/sienge/financialForecastContract.js";
import { deleteContract } from "../modules/sienge/deleteContract.js";
import { log, success } from "../core/logger.js";
import { dismissCommonPopups } from "../core/popups.js";

const MAX_STEP1_RETRIES = 2;
const MAX_FULL_RETRIES = 2;

function registerGlobalDialogHandler(page) {
    page.on("dialog", async (dialog) => {
        try {
            log("DIALOG", `${dialog.type()}: ${dialog.message()}`);
            await dialog.accept();
        } catch (_) { }
    });
}

async function waitForPageReady(page) {
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => { });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => { });
}

/**
 * Modo interativo (CLI)
 */
export async function processInitialContract() {
    log("SERVICE", "Iniciando fluxo total do contrato (modo interativo)...");
    const { page } = await siengeLogin();
    registerGlobalDialogHandler(page);
    await waitForPageReady(page);
    await dismissCommonPopups(page, 3000).catch(() => { });

    try {
        const contractInfo = await createInitialContract(page);
        log("SERVICE", "Iniciando Etapa 2: Cadastro de Itens...");
        await itemsContract(page);

        log("SERVICE", "Iniciando Etapa 3: Previsões Financeiras...");
        await financialForecastContract(page);

        success("SERVICE", "Todas as etapas finalizadas.");
        return contractInfo;
    } catch (error) {
        log("SERVICE", `Falha no processo: ${error.message}`);
        throw error;
    }
}

/**
 * Modo automático — chamado pelo PaymentFlowPipelineService.
 *
 * @param {object} params
 * @param {string} params.documento
 * @param {string} params.objeto
 * @param {string} params.empresa
 * @param {string} params.fornecedor
 * @param {string} params.tipoContrato
 * @param {string} params.dataInicio
 * @param {string} params.dataTermino
 * @param {string} params.obraCod
 * @param {string} params.unidade
 * @param {string|number} params.itemOrcamento
 * @param {string|number} params.itemOrcamentoCode
 * @param {string|number} params.contaFinanceira
 * @param {string} params.percentualAlocacao
 * @param {string} params.precoMO
 * @param {string|number} params.departmentId
 * @param {string|number} params.departamento
 * @param {string} params.dataVencimento
 * @param {string} params.dataVencimentoBase
 * @param {string|number} params.percentualParcela
 * @returns {{ documentId: string, contractNumber: string }}
 */
export async function runPlaywrightContract(params = {}) {
    log("SERVICE", "Iniciando fluxo automático do contrato...");
    log("SERVICE", `Parâmetros: ${JSON.stringify({
        documento: params.documento,
        empresa: params.empresa,
        fornecedor: params.fornecedor,
        itemOrcamento: params.itemOrcamento,
        itemOrcamentoCode: params.itemOrcamentoCode,
        contaFinanceira: params.contaFinanceira,
        departmentId: params.departmentId ?? params.departamento ?? null,
        dataVencimento: params.dataVencimento ?? params.dataVencimentoBase ?? null,
    })}`);

    const credentials = params.credentials || {};
    const { browser, page } = await siengeLogin(credentials);
    registerGlobalDialogHandler(page);
    await waitForPageReady(page);
    await dismissCommonPopups(page, 3000).catch(() => { });

    try {
        return await _runWithRetry(page, params);
    } catch (error) {
        log("SERVICE", `Falha definitiva no fluxo automático: ${error.message}`);
        throw error;
    } finally {
        await browser.close().catch(() => { });
    }
}

async function _runWithRetry(page, params, attempt = 1) {
    let contractInfo = null;
    let step1LastErr;

    for (let t = 1; t <= MAX_STEP1_RETRIES; t++) {
        try {
            contractInfo = await createInitialContract(page, {
                documento: params.documento,
                objeto: params.objeto,
                empresa: params.empresa,
                fornecedor: params.fornecedor,
                tipoContrato: params.tipoContrato,
                dataInicio: params.dataInicio,
                dataTermino: params.dataTermino,
            });

            log("SERVICE", `Etapa 1 concluída (tentativa ${t}): ${contractInfo.documentId}/${contractInfo.contractNumber}`);
            step1LastErr = null;
            break;
        } catch (err) {
            step1LastErr = err;
            log("SERVICE", `Etapa 1 falhou (tentativa ${t}/${MAX_STEP1_RETRIES}): ${err.message}`);
            if (t < MAX_STEP1_RETRIES) {
                log("SERVICE", "Retentando Etapa 1...");
                await page.waitForTimeout(2000);
            }
        }
    }

    if (!contractInfo) throw step1LastErr;

    try {
        await itemsContract(page, {
            obraCod: params.obraCod,
            unidade: params.unidade,
            itemOrcamento: params.itemOrcamento,
            itemOrcamentoCode: params.itemOrcamentoCode,
            contaFinanceira: params.contaFinanceira,
            percentualAlocacao: params.percentualAlocacao,
            precoMO: params.precoMO,
        });

        await financialForecastContract(page, {
            obraCod: params.obraCod,
            departmentId: params.departmentId ?? params.departamento,
            dataVencimento: params.dataVencimento ?? params.dataVencimentoBase,
            percentualParcela: params.percentualParcela ?? "100",
        });

        success("SERVICE", `Fluxo automático concluído (tentativa ${attempt}).`);
        return contractInfo;
    } catch (flowErr) {
        log("SERVICE", `Etapa 2/3 falhou (tentativa ${attempt}/${MAX_FULL_RETRIES}): ${flowErr.message}`);

        if (attempt >= MAX_FULL_RETRIES) {
            throw new Error(`Fluxo falhou após ${MAX_FULL_RETRIES} tentativas: ${flowErr.message}`);
        }

        log("SERVICE", `Excluindo contrato ${contractInfo.documentId}/${contractInfo.contractNumber} para retentar...`);
        await deleteContract(page, {
            documentType: contractInfo.documentId,
            contractNumber: contractInfo.contractNumber,
        }).catch(delErr =>
            log("SERVICE", `Aviso: falha ao excluir contrato antes de retentar: ${delErr.message}`)
        );

        log("SERVICE", `Retentando fluxo completo (tentativa ${attempt + 1})...`);
        await page.waitForTimeout(2000);
        return _runWithRetry(page, params, attempt + 1);
    }
}
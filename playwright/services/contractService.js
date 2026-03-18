// playwright/services/contractService.js
import { siengeLogin } from "../modules/sienge/login.js";
import { createInitialContract } from "../modules/sienge/createContract.js";
import { itemsContract } from "../modules/sienge/itemsContract.js";
import { deleteContract } from "../modules/sienge/deleteContract.js";
import { log, success } from "../core/logger.js";
import { dismissCommonPopups } from "../core/popups.js";

const MAX_STEP1_RETRIES = 2;   // tentativas para a Etapa 1 (criação do contrato)
const MAX_FULL_RETRIES  = 2;   // tentativas completas após falha na Etapa 2 (itens)

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
 * Modo interativo (CLI) — mantido para uso manual via node ./index.js
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
        success("SERVICE", "Todas as etapas finalizadas.");
        return contractInfo;
    } catch (error) {
        log("SERVICE", `Falha no processo: ${error.message}`);
        throw error;
    }
}

/**
 * Modo automático — chamado pelo PaymentFlowPipelineService.
 * Recebe todos os parâmetros sem input do usuário.
 *
 * @param {object} params
 * @param {string} params.documento          - Tipo do documento (ex: PCEF)
 * @param {string} params.objeto             - Descrição/objeto do contrato
 * @param {string} params.empresa            - Código da empresa no Sienge
 * @param {string} params.fornecedor         - ID do credor no Sienge
 * @param {string} params.tipoContrato       - Tipo de contrato (padrão: "1")
 * @param {string} params.dataInicio         - dd/MM/yyyy
 * @param {string} params.dataTermino        - dd/MM/yyyy
 * @param {string} params.obraCod            - Código da obra (buildingId)
 * @param {string} params.unidade            - Unidade construtiva (padrão: "1")
 * @param {string|number} params.itemOrcamento   - Índice 1-based do item do orçamento
 * @param {string|number} params.itemOrcamentoCode   - Índice 1-based do item do orçamento
 * @param {string|number} params.contaFinanceira - Índice 1-based da conta financeira
 * @param {string} params.percentualAlocacao - Percentual (padrão: "100")
 * @param {string} params.precoMO            - Preço unitário mão de obra
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

/**
 * Executa as duas etapas com lógica de retry:
 *  - Etapa 1 (criação do contrato): tenta até MAX_STEP1_RETRIES vezes
 *  - Etapa 2 (itens): em caso de falha, exclui o contrato e recomeça do zero
 *    até MAX_FULL_RETRIES tentativas completas
 */
async function _runWithRetry(page, params, attempt = 1) {
    // ── Etapa 1: Criação do contrato ─────────────────────────────────────────
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

    // ── Etapa 2: Itens do contrato ───────────────────────────────────────────
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
        success("SERVICE", `Fluxo automático concluído (tentativa ${attempt}).`);
        return contractInfo;
    } catch (itemsErr) {
        log("SERVICE", `Etapa 2 falhou (tentativa ${attempt}/${MAX_FULL_RETRIES}): ${itemsErr.message}`);

        if (attempt >= MAX_FULL_RETRIES) {
            throw new Error(`Etapa 2 falhou após ${MAX_FULL_RETRIES} tentativas: ${itemsErr.message}`);
        }

        // Exclui o contrato recém-criado para poder tentar novamente
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
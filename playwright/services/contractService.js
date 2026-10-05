// playwright/services/contractService.js
import { siengeLogin } from "../modules/sienge/login.js";
import { createInitialContract } from "../modules/sienge/createContract.js";
import { itemsContract } from "../modules/sienge/itemsContract.js";
import { financialForecastContract } from "../modules/sienge/financialForecastContract.js";
import { deleteContract } from "../modules/sienge/deleteContract.js";
import { comLoginNaFila } from "../core/filaSienge.js";
import { SiengeContractService } from "../../services/sienge/SiengeContractService.js";
import { cautionContract } from "../modules/sienge/cautionContract.js";
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

        log("SERVICE", "Iniciando Etapa 4: Caução conferida...");
        await cautionContract(page);

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

    // Na fila do login. Antes de criar, anota os contratos do fornecedor na
    // empresa: derrubado no meio, a retomada EXCLUI o contrato novo que ficou
    // pela metade e cria de novo (o mesmo que já faz quando a etapa 2/3 falha).
    const antes = new Set(await contratosDoFornecedor(params).catch(() => []));
    return comLoginNaFila(params.credentials, `contrato ${params.documento} do fornecedor ${params.fornecedor}`, async (page, { retomando }) => {
        if (retomando) {
            const novos = (await contratosDoFornecedor(params)).filter(c => !antes.has(c));
            for (const numero of novos) {
                log("SERVICE", `Retomando: excluindo o contrato ${params.documento}/${numero} que ficou pela metade na queda...`);
                await deleteContract(page, { documentType: params.documento, contractNumber: numero });
            }
        }
        try {
            return await _runWithRetry(page, params);
        } catch (error) {
            log("SERVICE", `Falha no fluxo automático: ${error.message}`);
            throw error;
        }
    });
}

/** Números dos contratos do fornecedor na empresa, no documento do tipo (API, só leitura). */
async function contratosDoFornecedor({ fornecedor, empresa, documento }) {
    const todos = await SiengeContractService.findAllBySupplierId(fornecedor, empresa);
    return todos
        .filter(c => String(c.documentId || "").trim().toUpperCase() === String(documento || "").trim().toUpperCase())
        .map(c => String(c.contractNumber));
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

        // Etapa 4: sem "Caução conferida" o contrato fica incompleto e não vai
        // para autorização (01/10/2026). Falhar aqui NÃO exclui o contrato
        // (ele está certo); o lançamento avisa para conferir à mão.
        const avisos = [];
        try {
            await cautionContract(page);
        } catch (cauErr) {
            log("SERVICE", `Etapa 4 (caução) falhou: ${cauErr.message}`);
            avisos.push(`Contrato criado, mas a caução não foi marcada como conferida (${cauErr.message}). No Sienge: aba Caução, marque "Caução conferida" e salve, senão o contrato não vai para autorização.`);
        }

        success("SERVICE", `Fluxo automático concluído (tentativa ${attempt}).`);
        return { ...contractInfo, avisos };
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
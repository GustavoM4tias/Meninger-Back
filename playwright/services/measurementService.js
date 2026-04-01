// playwright/services/measurementService.js
import { siengeLogin } from "../modules/sienge/login.js";
import { createMeasurement } from "../modules/sienge/measurement.js";
import { log, success } from "../core/logger.js";
import { dismissCommonPopups } from "../core/popups.js";

function registerGlobalDialogHandler(page) {
    page.on("dialog", async (dialog) => {
        try {
            log("DIALOG", `${dialog.type()}: ${dialog.message()}`);
            await dialog.accept();
        } catch (_) {}
    });
}

async function waitForPageReady(page) {
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
}

/**
 * Modo automático — chamado pelo PaymentFlowPipelineService.
 *
 * @param {object} params
 * @param {string} params.documentType      - Tipo do documento (ex: "CT")
 * @param {string} params.contractNumber    - Número do contrato existente
 * @param {string} params.obraCod           - Código da obra (erpId)
 * @param {string} params.dataVencimento    - DD/MM/YYYY (data de vencimento do boleto)
 * @param {string|number} params.value      - Valor da medição (unitPrice)
 * @param {number} [params.targetRowIndex]  - Índice 1-based do item editável a preencher (padrão: 1)
 * @param {object} params.credentials       - { email, password } do Sienge
 * @returns {{ success: true, measurementNumber: number|null }}
 */
export async function runPlaywrightMeasurement(params = {}) {
    log("SERVICE", "Iniciando fluxo automático da medição...");
    log("SERVICE", `Parâmetros: ${JSON.stringify({
        documentType: params.documentType,
        contractNumber: params.contractNumber,
        obraCod: params.obraCod,
        dataVencimento: params.dataVencimento,
        value: params.value,
        targetRowIndex: params.targetRowIndex ?? 1,
    })}`);

    const credentials = params.credentials || {};
    const { browser, page } = await siengeLogin(credentials);
    registerGlobalDialogHandler(page);
    await waitForPageReady(page);
    await dismissCommonPopups(page, 3000).catch(() => {});

    try {
        const result = await createMeasurement(page, params);
        success("SERVICE", `Fluxo automático da medição concluído. Nº: ${result.measurementNumber ?? "?"}`);
        return { success: true, measurementNumber: result.measurementNumber };
    } catch (error) {
        log("SERVICE", `Falha no fluxo automático da medição: ${error.message}`);
        throw error;
    } finally {
        await browser.close().catch(() => {});
    }
}

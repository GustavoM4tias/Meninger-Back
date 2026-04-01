// playwright/services/tituloService.js
import { siengeLogin } from "../modules/sienge/login.js";
import { createTitulo } from "../modules/sienge/titulo.js";
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
 * Cria a liberação de medição (título) no Sienge via Playwright.
 *
 * @param {object} params
 * @param {string}        params.documentType      - Tipo do contrato (ex: "PREM")
 * @param {string}        params.contractNumber    - Número do contrato (ex: "1")
 * @param {number}        params.measurementNumber - Número da medição
 * @param {string}        params.nfType            - Tipo do documento fiscal (ex: "NFS")
 * @param {string}        params.nfNumber          - Número da NF
 * @param {string}        params.nfIssueDate       - Data de emissão da NF (ISO)
 * @param {string}        params.boletoDueDate     - Data de vencimento do boleto (ISO)
 * @param {string}        params.departamento      - Código do departamento
 * @param {string|number} params.unitPrice         - Valor de mão de obra
 * @param {object}        params.credentials       - { email, password }
 * @returns {{ success: true, tituloNumber: number|null }}
 */
export async function runPlaywrightTitulo(params = {}) {
    log("SERVICE", "Iniciando fluxo automático de criação de título...");
    log("SERVICE", `Parâmetros: ${JSON.stringify({
        documentType: params.documentType,
        contractNumber: params.contractNumber,
        measurementNumber: params.measurementNumber,
        nfType: params.nfType,
        nfNumber: params.nfNumber,
        departamento: params.departamento,
    })}`);

    const credentials = params.credentials || {};
    const { browser, page } = await siengeLogin(credentials);
    registerGlobalDialogHandler(page);
    await waitForPageReady(page);
    await dismissCommonPopups(page, 3000).catch(() => {});

    try {
        const result = await createTitulo(page, params);
        success("SERVICE", `Fluxo de título concluído. Nº: ${result.tituloNumber ?? "?"}`);
        return { success: true, tituloNumber: result.tituloNumber };
    } catch (error) {
        log("SERVICE", `Falha no fluxo de título: ${error.message}`);
        throw error;
    } finally {
        await browser.close().catch(() => {});
    }
}

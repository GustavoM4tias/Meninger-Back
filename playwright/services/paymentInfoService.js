// playwright/services/paymentInfoService.js
import { siengeLogin } from "../modules/sienge/login.js";
import { setPaymentInfo } from "../modules/sienge/paymentInfo.js";
import { log } from "../core/logger.js";
import { dismissCommonPopups } from "../core/popups.js";

/**
 * Grava a forma de pagamento (boleto ou PIX) na parcela do título, pela tela.
 * @param {object} params - { credentials, titulo, parcela, origem, tipo, linhaDigitavel, descricao }
 */
export async function runPlaywrightPaymentInfo(params = {}) {
    const { browser, page } = await siengeLogin(params.credentials || {});
    page.on("dialog", async (dialog) => {
        try {
            log("DIALOG", `${dialog.type()}: ${dialog.message()}`);
            await dialog.accept();
        } catch (_) { }
    });
    try {
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => { });
        await dismissCommonPopups(page, 3000).catch(() => { });
        return await setPaymentInfo(page, params);
    } finally {
        await browser.close().catch(() => { });
    }
}

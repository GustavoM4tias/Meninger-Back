// playwright/services/paymentInfoService.js
import { siengeLogin } from "../modules/sienge/login.js";
import { setPaymentInfo, anexarNoTitulo, finalizarLiberacao } from "../modules/sienge/paymentInfo.js";
import { log } from "../core/logger.js";
import { dismissCommonPopups } from "../core/popups.js";

/**
 * Num login só: forma de pagamento da parcela (boleto ou PIX) e/ou anexos do título.
 * @param {object} params - { credentials, titulo, parcela, origem, tipo?, linhaDigitavel, descricao, anexos? }
 *   tipo ausente = só anexa; anexos vazio = só forma de pagamento.
 *   finalizar = { documentType, contractNumber, measurementNumber }: finaliza a
 *   liberação da medição no fim (o Sienge só finaliza com o título completo).
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
        const out = {};
        if (params.tipo) out.pagamento = await setPaymentInfo(page, params);
        // Anexo falhar não desfaz a forma de pagamento já salva: volta como aviso.
        if (params.anexos?.length) {
            try { out.anexos = await anexarNoTitulo(page, params); }
            catch (err) { out.anexoErro = err.message; }
        }
        if (params.finalizar?.measurementNumber && !out.anexoErro) {
            try { out.liberacao = await finalizarLiberacao(page, params.finalizar); }
            catch (err) { out.liberacaoErro = err.message; }
        }
        return out;
    } finally {
        await browser.close().catch(() => { });
    }
}

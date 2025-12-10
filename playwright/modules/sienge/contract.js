// playwright/modules/sienge/contract.js
import { log, success } from "../../core/logger.js";
import { dismissCommonPopups } from "../../core/popups.js";

const CONTRACT_PAGE_URL =
    "https://menin.sienge.com.br/sienge/8/index.html#/common/page/1309";

export async function createInitialContract(page) {
    log("CONTRACT", "Indo para página de contrato...");
    await page.goto(CONTRACT_PAGE_URL, { waitUntil: "domcontentloaded" });

    // Popups logo ao entrar
    await dismissCommonPopups(page, 4000);

    // iframe
    const iframeHandle = await page.waitForSelector('iframe[title="iFramePage"]', {
        timeout: 20000
    });
    const frame = await iframeHandle.contentFrame();
    if (!frame) {
        throw new Error("Não foi possível acessar o iframe da tela de contrato (page 1309).");
    }

    // Popups que podem ter carregado após o iframe
    await dismissCommonPopups(page, 2000);

    // ==========================
    // 1) DOCUMENTO = CT
    // ==========================
    log("CONTRACT", "Preenchendo Documento = CT...");

    const documentoInput = frame.locator(
        'input[name="cadContrato.contratoPK.cdDocumento"]'
    );

    await documentoInput.waitFor({ timeout: 15000 });
    await documentoInput.fill("CT");

    // Se algum popup disparar ao mexer no form
    await dismissCommonPopups(page, 2000);

    // ==========================
    // 2) GERAR NÚMERO (btGerarCodigo)
    // ==========================
    log("CONTRACT", "Clicando em Gerar Código...");

    // Tratar eventual dialog
    page.once("dialog", async (dialog) => {
        console.log("Dialog:", dialog.message());
        await dialog.dismiss().catch(() => { });
    });

    const gerarBtn = frame.locator("#btGerarCodigo"); // <img id="btGerarCodigo" ...>
    await gerarBtn.waitFor({ timeout: 10000 });
    await gerarBtn.click();

    await dismissCommonPopups(page, 2000);

    // ==========================
    // 3) OBJETO = PREMIAÇÃO...
    // ==========================
    log("CONTRACT", "Preenchendo Objeto...");

    const objetoTextarea = frame.locator(
        'textarea[name="cadContrato.deContrato"]'
    );

    await objetoTextarea.waitFor({ timeout: 15000 });
    await objetoTextarea.fill("PREMIAÇÃO POR VENDAS AUTOMATICO");

    success("CONTRACT", "Contrato preenchido até Documento, Número e Objeto 🎉");
}

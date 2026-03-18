// playwright/modules/sienge/createContract.js
import { log, success } from "../../core/logger.js";
import { dismissCommonPopups } from "../../core/popups.js";

const CONTRACT_PAGE_URL = "https://menin.sienge.com.br/sienge/8/index.html#/common/page/1309";
const MAIN_IFRAME_SELECTOR = 'iframe[title="iFramePage"]';

async function waitForPageSettled(page) {
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => { });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => { });
}

async function getMainFrame(page, timeout = 60000) {
    const iframeHandle = await page.waitForSelector(MAIN_IFRAME_SELECTOR, { state: "attached", timeout });
    const frame = await iframeHandle.contentFrame();
    if (!frame) throw new Error("Iframe principal não encontrado.");
    await frame.waitForLoadState("domcontentloaded", { timeout }).catch(() => { });
    return frame;
}

async function waitVisible(target, selector, timeout = 60000) {
    const locator = target.locator(selector);
    await locator.waitFor({ state: "visible", timeout });
    return locator;
}

async function closeBlockingPopups(page) {
    await dismissCommonPopups(page, 3000).catch(() => { });
    const overlays = [
        ".beamerAnnouncementPopupContainer.beamerAnnouncementPopupActive",
        ".beamer_defaultBeamerSelector",
        '[id*="beamer"]', '[class*="beamer"]',
        ".modal-backdrop", ".ui-widget-overlay",
    ];
    for (const sel of overlays) {
        const count = await page.locator(sel).count().catch(() => 0);
        if (!count) continue;
        try {
            if (await page.locator(sel).first().isVisible().catch(() => false)) {
                await page.keyboard.press("Escape").catch(() => { });
            }
        } catch (_) { }
    }
}

async function waitUiStability(page) {
    await closeBlockingPopups(page);
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => { });
    await closeBlockingPopups(page);
}

function isPointerInterceptError(e) {
    const m = e?.message || "";
    return m.includes("intercepts pointer events") ||
        m.includes("another element would receive the click") ||
        m.includes("Element is not attached to the DOM");
}

async function safeClick(page, target, selector, options = {}) {
    const timeout = options.timeout ?? 60000;
    const locator = await waitVisible(target, selector, timeout);
    await locator.scrollIntoViewIfNeeded().catch(() => { });
    await closeBlockingPopups(page);
    try {
        await locator.click(options);
    } catch (err) {
        if (!isPointerInterceptError(err)) throw err;
        log("UI", `Clique interceptado em ${selector}. Repetindo...`);
        await closeBlockingPopups(page);
        const retry = await waitVisible(target, selector, timeout);
        await retry.scrollIntoViewIfNeeded().catch(() => { });
        await retry.click(options);
    }
    await waitUiStability(page);
    return locator;
}

async function safeFill(page, target, selector, value, options = {}) {
    const locator = await waitVisible(target, selector, options.timeout ?? 60000);
    await locator.scrollIntoViewIfNeeded().catch(() => { });
    await closeBlockingPopups(page);
    await locator.click().catch(() => { });
    await locator.fill("");
    await locator.fill(String(value ?? ""));
    return locator;
}

async function safeFillAndTab(page, target, selector, value, options = {}) {
    const locator = await safeFill(page, target, selector, value, options);
    await locator.press("Tab");
    await waitUiStability(page);
    return locator;
}

async function waitGeneratedCode(frame, timeout = 30000) {
    const selectors = [
        'input[name="cadContrato.contratoPK.nuContrato"]',
        'input[name*="nuContrato"]',
        '#cadContrato\\.contratoPK\\.nuContrato',
    ];
    let codeInput = null;
    for (const sel of selectors) {
        const locator = frame.locator(sel).first();
        if (await locator.count().catch(() => 0)) { codeInput = locator; break; }
    }
    if (!codeInput) return null;

    await codeInput.waitFor({ state: "visible", timeout }).catch(() => { });
    const code = await codeInput.evaluate(async (el, ms) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            const v = String(el.value ?? "").trim();
            if (v) return v;
            await new Promise(r => requestAnimationFrame(r));
        }
        return null;
    }, timeout);

    return code;
}

/**
 * Cria o contrato inicial no Sienge.
 * @param {object} page   - Playwright page
 * @param {object} params - Todos os parâmetros que antes vinham do askQuestion
 * @returns {{ documentId, contractNumber }}
 */
export async function createInitialContract(page, params = {}) {
    const {
        documento = "PCEF",
        objeto = "CONTRATO AUTOMÁTICO PAYMENT FLOW",
        empresa = "97",
        fornecedor = "",
        tipoContrato = "1",
        dataInicio = "01/01/2026",
        dataTermino = "31/12/2026",
    } = params;

    log("CONTRACT", `Navegando para a página de contratos...`);
    await page.goto(CONTRACT_PAGE_URL, { waitUntil: "domcontentloaded" });
    await waitForPageSettled(page);
    await closeBlockingPopups(page);

    let frame = await getMainFrame(page);

    log("CONTRACT", `Preenchendo Documento: ${documento}`);
    await safeFillAndTab(page, frame, 'input[name="cadContrato.contratoPK.cdDocumento"]', documento);

    log("CONTRACT", "Gerando código do contrato...");
    await safeClick(page, frame, "#btGerarCodigo");
    const contractNumber = await waitGeneratedCode(frame, 30000);
    log("CONTRACT", `Código gerado: ${contractNumber}`);

    log("CONTRACT", "Preenchendo Objeto...");
    await safeFill(page, frame, 'textarea[name="cadContrato.deContrato"]', objeto);

    log("CONTRACT", `Preenchendo Empresa: ${empresa}`);
    await safeFillAndTab(page, frame, 'id=cadContrato.empresa.cdEmpresaView', empresa);

    log("CONTRACT", `Preenchendo Fornecedor: ${fornecedor}`);
    await safeFillAndTab(page, frame, 'id=cadContrato.cdFornecedor', fornecedor);

    log("CONTRACT", `Preenchendo Tipo de Contrato: ${tipoContrato}`);
    await safeFillAndTab(page, frame, 'id=cadContrato.cdTipoContrato', tipoContrato);

    log("CONTRACT", "Preenchendo Datas...");
    await safeFill(page, frame, 'id=cadContrato.dtInicio', dataInicio);
    await safeFill(page, frame, 'id=cadContrato.dtTermino', dataTermino);

    await closeBlockingPopups(page);
    log("CONTRACT", "Salvando contrato...");
    await safeClick(page, frame, 'id=botaoSubmit');
    await waitForPageSettled(page);
    await closeBlockingPopups(page);

    frame = await getMainFrame(page);
    await waitVisible(frame, 'id=botaoSubmit', 60000);

    success("CONTRACT", `Etapa 1 concluída: Contrato ${documento}/${contractNumber} criado.`);
    return { documentId: documento, contractNumber };
}

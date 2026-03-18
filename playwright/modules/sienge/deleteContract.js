// playwright/modules/sienge/deleteContract.js
import { log, success } from "../../core/logger.js";
import { dismissCommonPopups } from "../../core/popups.js";

// Mesma URL de listagem de contratos usada pelo additive.js
const CONTRACTS_PAGE_URL =
    "https://menin.sienge.com.br/sienge/8/index.html#/suprimentos/contratos-e-medicoes/contratos/cadastros";
const MAIN_IFRAME_SELECTOR = 'iframe[title="iFramePage"]';

// ── helpers ────────────────────────────────────────────────────────────────────

async function waitForPageSettled(page) {
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
}

async function getMainFrame(page, timeout = 90000) {
    const deadline = Date.now() + timeout;
    let lastErr;
    while (Date.now() < deadline) {
        try {
            const remaining = deadline - Date.now();
            const h = await page.waitForSelector(MAIN_IFRAME_SELECTOR, {
                state: "attached",
                timeout: Math.min(remaining, 8000),
            });
            const f = await h.contentFrame();
            if (!f) { await page.waitForTimeout(800); continue; }
            await f.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
            return f;
        } catch (err) {
            lastErr = err;
            await page.waitForTimeout(1000);
        }
    }
    throw new Error(`Iframe não encontrado após ${timeout}ms. Último erro: ${lastErr?.message}`);
}

async function closeBlockingPopups(page) {
    await dismissCommonPopups(page, 3000).catch(() => {});
    const overlays = [
        ".beamerAnnouncementPopupContainer.beamerAnnouncementPopupActive",
        ".beamer_defaultBeamerSelector",
        '[id*="beamer"]',
        '[class*="beamer"]',
        ".modal-backdrop",
        ".ui-widget-overlay",
    ];
    for (const sel of overlays) {
        const count = await page.locator(sel).count().catch(() => 0);
        if (!count) continue;
        try {
            if (await page.locator(sel).first().isVisible().catch(() => false)) {
                await page.keyboard.press("Escape").catch(() => {});
            }
        } catch (_) {}
    }
}

async function waitUiStability(page) {
    await closeBlockingPopups(page);
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await closeBlockingPopups(page);
}

// ── main export ────────────────────────────────────────────────────────────────

/**
 * Exclui um contrato existente no Sienge.
 *
 * Fluxo:
 *  1. Navega para a listagem de contratos (React SPA)
 *  2. Preenche Documento + Número e clica em Consultar
 *  3. Clica em "Editar contrato" na grid
 *  4. Aguarda iframe da página antiga do Sienge
 *  5. Clica em "Excluir" e confirma
 *
 * @param {object} page            - Playwright page já autenticada
 * @param {object} params
 * @param {string} params.documentType    - Ex: "CT", "PCEF"
 * @param {string} params.contractNumber  - Número do contrato
 */
export async function deleteContract(page, params = {}) {
    const { documentType = "CT", contractNumber = "" } = params;

    if (!contractNumber) throw new Error("deleteContract: contractNumber é obrigatório.");

    // ── FASE 1: Buscar contrato na listagem ──────────────────────────────────
    log("DELETE_CONTRACT", `Navegando para listagem de contratos...`);
    await page.goto(CONTRACTS_PAGE_URL, { waitUntil: "domcontentloaded" });
    await waitForPageSettled(page);
    await closeBlockingPopups(page);

    // Documento (MUI Autocomplete)
    log("DELETE_CONTRACT", `Preenchendo Documento: ${documentType}`);
    const docInput = page.locator('.MuiAutocomplete-root[name="cdDocumento"] input[type="text"]');
    await docInput.waitFor({ state: "visible", timeout: 30000 });
    await docInput.click();
    await docInput.fill("");
    await docInput.type(documentType, { delay: 1200 });

    const listbox = page.locator('[role="listbox"]');
    await listbox.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    const exactOption = page
        .locator('[role="option"]')
        .filter({ hasText: new RegExp(`^${documentType}$`) });
    const hasExact = await exactOption.count().then(c => c > 0).catch(() => false);
    if (hasExact) {
        await exactOption.first().click();
    } else {
        const first = page.locator('[role="option"]').first();
        if (await first.isVisible({ timeout: 3000 }).catch(() => false)) {
            await first.click();
        } else {
            await docInput.press("Tab");
        }
    }
    await page.waitForTimeout(400);

    // Número
    log("DELETE_CONTRACT", `Preenchendo Número: ${contractNumber}`);
    const numInput = page.locator('input[name="nuContrato"]');
    await numInput.waitFor({ state: "visible", timeout: 10000 });
    await numInput.fill(String(contractNumber));

    // Consultar
    const consultarBtn = page.locator('button[type="submit"]').last();
    await consultarBtn.waitFor({ state: "visible", timeout: 10000 });
    await consultarBtn.click();

    log("DELETE_CONTRACT", "Aguardando resultados...");
    await page.waitForSelector(".MuiDataGrid-row", { state: "visible", timeout: 30000 });
    await page.waitForTimeout(800);

    // Encontrar botão de editar
    const editSelectors = [
        '[aria-label="Editar contrato"]',
        '[aria-label*="ditar"]',
        '[aria-label*="Edit"]',
        '.MuiDataGrid-row button:has(svg[data-testid="EditIcon"])',
        '.MuiDataGrid-row button:has(svg[data-testid="ModeEditIcon"])',
    ];

    let editBtn = null;
    for (const sel of editSelectors) {
        const count = await page.locator(sel).count();
        if (count > 0) {
            editBtn = page.locator(sel).first();
            break;
        }
    }
    if (!editBtn) throw new Error(`Botão de editar não encontrado ao excluir contrato ${documentType}/${contractNumber}`);

    await editBtn.scrollIntoViewIfNeeded().catch(() => {});
    await editBtn.click({ force: true });

    // ── FASE 2: Aguardar iframe da página antiga ─────────────────────────────
    log("DELETE_CONTRACT", "Aguardando página de edição...");
    await page
        .waitForURL(url => !url.includes("contratos/cadastros"), { timeout: 20000 })
        .catch(() => {});
    await waitForPageSettled(page);
    await closeBlockingPopups(page);

    const frame = await getMainFrame(page);

    // ── FASE 3: Clicar em Excluir ────────────────────────────────────────────
    log("DELETE_CONTRACT", `Excluindo contrato ${documentType}/${contractNumber}...`);

    // O botão Excluir pode ser encontrado pelo id ou value
    const excluirBtn = frame.locator('#botaoExcluir, input[value="Excluir"]').first();
    await excluirBtn.waitFor({ state: "visible", timeout: 30000 });
    await excluirBtn.scrollIntoViewIfNeeded().catch(() => {});

    // Registra handler de confirmação ANTES de clicar
    page.once("dialog", async (dialog) => {
        log("DELETE_CONTRACT", `Confirmando dialog: ${dialog.message()}`);
        await dialog.accept().catch(() => {});
    });

    await excluirBtn.click();
    await waitUiStability(page);

    success("DELETE_CONTRACT", `Contrato ${documentType}/${contractNumber} excluído com sucesso.`);
    return { success: true, documentType, contractNumber };
}

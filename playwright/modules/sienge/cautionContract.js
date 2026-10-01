// playwright/modules/sienge/cautionContract.js
//
// Etapa 4 do contrato: aba "Caução" -> marcar "Caução conferida" -> Salvar.
//
// Desde 01/10/2026 o Sienge trata a caução não conferida como pendência: o
// contrato fica "incompleto" e NÃO vai para autorização (aviso "O contrato
// está incompleto: (1) caução não conferida"). Foi o RB/59 do Reembolso.
// Os demais campos da aba ficam como o Sienge sugere (0,00%, documento CAU).

import { log, success } from "../../core/logger.js";
import { dismissCommonPopups } from "../../core/popups.js";

const MAIN_IFRAME_SELECTOR = 'iframe[title="iFramePage"]';

async function getMainFrame(page, timeout = 60000) {
    const h = await page.waitForSelector(MAIN_IFRAME_SELECTOR, { state: "attached", timeout });
    const f = await h.contentFrame();
    if (!f) throw new Error("Iframe principal não encontrado.");
    await f.waitForLoadState("domcontentloaded", { timeout }).catch(() => { });
    return f;
}

async function settle(page) {
    await dismissCommonPopups(page, 3000).catch(() => { });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => { });
}

/** Checkbox ao lado do texto "Caução conferida" (label, ou o input logo antes do texto). */
function conferidaCheckbox(frame) {
    return frame.locator([
        'label:has-text("Caução conferida") input[type="checkbox"]',
        'xpath=//label[contains(normalize-space(.),"Caução conferida")]/preceding-sibling::input[@type="checkbox"][1]',
        'xpath=//*[contains(normalize-space(text()),"Caução conferida")]/preceding::input[@type="checkbox"][1]',
    ].join(", ")).first();
}

export async function cautionContract(page) {
    log("CAUCAO", "Iniciando Etapa 4: Caução conferida...");
    await settle(page);
    let frame = await getMainFrame(page);

    log("CAUCAO", "Abrindo a aba Caução...");
    const aba = frame.locator("a").filter({ hasText: /^\s*Caução\s*$/ }).first();
    await aba.waitFor({ state: "visible", timeout: 30000 });
    await aba.click();
    await settle(page);
    frame = await getMainFrame(page);

    const box = conferidaCheckbox(frame);
    await box.waitFor({ state: "attached", timeout: 30000 });
    if (await box.isChecked().catch(() => false)) {
        success("CAUCAO", "Caução já estava conferida.");
        return { conferida: true, jaEstava: true };
    }

    log("CAUCAO", 'Marcando "Caução conferida"...');
    await box.scrollIntoViewIfNeeded().catch(() => { });
    await box.check({ force: true });

    log("CAUCAO", "Salvando...");
    const salvar = frame.locator('input[name="pbSalvar"], input[type="submit"][value="Salvar"], button:has-text("Salvar")').first();
    await salvar.waitFor({ state: "visible", timeout: 30000 });
    await salvar.click();
    await settle(page);

    // Conferência: reabre a aba e lê o checkbox de novo.
    frame = await getMainFrame(page);
    const aba2 = frame.locator("a").filter({ hasText: /^\s*Caução\s*$/ }).first();
    if (await aba2.isVisible().catch(() => false)) {
        await aba2.click().catch(() => { });
        await settle(page);
        frame = await getMainFrame(page);
    }
    const ok = await conferidaCheckbox(frame).isChecked().catch(() => false);
    if (!ok) throw new Error('Caução: o Sienge não gravou "Caução conferida" (o contrato fica incompleto e não vai para autorização).');

    success("CAUCAO", "Etapa 4 concluída: caução conferida.");
    return { conferida: true, jaEstava: false };
}

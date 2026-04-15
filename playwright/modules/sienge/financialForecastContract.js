import { log, success } from "../../core/logger.js";
import { dismissCommonPopups } from "../../core/popups.js";

const MAIN_IFRAME_SELECTOR = 'iframe[title="iFramePage"]';

async function waitForPageSettled(page) {
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => { });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => { });
}

async function getMainFrame(page, timeout = 60000) {
    const h = await page.waitForSelector(MAIN_IFRAME_SELECTOR, { state: "attached", timeout });
    const f = await h.contentFrame();
    if (!f) throw new Error("Iframe principal não encontrado.");
    await f.waitForLoadState("domcontentloaded", { timeout }).catch(() => { });
    return f;
}

async function waitVisible(target, selector, timeout = 60000) {
    const l = target.locator(selector);
    await l.waitFor({ state: "visible", timeout });
    return l;
}

async function closeBlockingPopups(page) {
    await dismissCommonPopups(page, 3000).catch(() => { });

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
    return (
        m.includes("intercepts pointer events") ||
        m.includes("another element would receive the click") ||
        m.includes("Element is not attached to the DOM")
    );
}

async function safeClick(page, target, selector, options = {}) {
    const timeout = options.timeout ?? 60000;
    const loc = await waitVisible(target, selector, timeout);
    await loc.scrollIntoViewIfNeeded().catch(() => { });
    await closeBlockingPopups(page);

    try {
        await loc.click(options);
    } catch (err) {
        if (!isPointerInterceptError(err)) throw err;
        log("FORECAST", `Clique interceptado em ${selector}. Repetindo...`);
        await closeBlockingPopups(page);
        const retry = await waitVisible(target, selector, timeout);
        await retry.scrollIntoViewIfNeeded().catch(() => { });
        await retry.click(options);
    }

    await waitUiStability(page);
    return loc;
}

async function safeFill(page, target, selector, value, options = {}) {
    const loc = await waitVisible(target, selector, options.timeout ?? 60000);
    await loc.scrollIntoViewIfNeeded().catch(() => { });
    await closeBlockingPopups(page);
    await loc.click().catch(() => { });
    await loc.fill("");
    await loc.fill(String(value ?? ""));
    return loc;
}

async function safeFillAndTab(page, target, selector, value, options = {}) {
    const loc = await safeFill(page, target, selector, value, options);
    await loc.press("Tab").catch(() => { });
    await waitUiStability(page);
    return loc;
}

function parseBrazilianDate(value) {
    const raw = String(value || "").trim();
    const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);

    if (!match) {
        throw new Error(`Data inválida para previsão financeira: "${value}"`);
    }

    const [, dd, mm, yyyy] = match;
    const day = Number(dd);
    const month = Number(mm);
    const year = Number(yyyy);

    const date = new Date(year, month - 1, day);
    if (
        Number.isNaN(date.getTime()) ||
        date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day
    ) {
        throw new Error(`Data inválida para previsão financeira: "${value}"`);
    }

    const lastDay = new Date(year, month, 0).getDate();
    return `${String(lastDay).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
}

async function getLatestForecastRow(frame) {
    const rows = frame.locator('tr[id^="linhaRowParcelaAberta_"]:not([id*="-1"])');
    await rows.first().waitFor({ state: "visible", timeout: 30000 });
    const count = await rows.count();

    if (!count) {
        throw new Error("Nenhuma linha de previsão financeira foi criada.");
    }

    return rows.nth(count - 1);
}

export async function financialForecastContract(page, params = {}) {
    const {
        obraCod = "",
        departmentId = "",
        departamento = "",
        dataVencimento = "",
        dataVencimentoBase = "",
        percentualParcela = "100",
    } = params;

    const departmentValue = String(departmentId || departamento || "").trim();
    const dueDateValue = String(dataVencimento || dataVencimentoBase || "").trim();

    if (!obraCod) {
        throw new Error("Parâmetro obrigatório ausente: obraCod.");
    }

    if (!departmentValue) {
        throw new Error("Parâmetro obrigatório ausente: departmentId/departamento.");
    }

    if (!dueDateValue) {
        throw new Error("Parâmetro obrigatório ausente: dataVencimento/dataVencimentoBase.");
    }

    const dtVencimento = parseBrazilianDate(dueDateValue);

    log("FORECAST", "Iniciando Etapa 3: Previsões Financeiras...");
    log("FORECAST", `Dados recebidos: obraCod=${obraCod}, departmentId=${departmentValue}, dataVencimento=${dtVencimento}, percentualParcela=${percentualParcela}`);

    await closeBlockingPopups(page);

    let frame = await getMainFrame(page);

    log("FORECAST", "Acessando menu Previsões Financeiras...");
    await safeClick(page, frame, 'a:has-text("Previsões Financeiras")');

    frame = await getMainFrame(page);

    log("FORECAST", "Criando nova previsão...");
    await safeClick(page, frame, 'input[name="pbEnviar"][value="Novo"]');

    frame = await getMainFrame(page);

    log("FORECAST", `Preenchendo Obra/Centro de Custo: ${obraCod}`);
    await safeFillAndTab(page, frame, 'id=obraContrato.obra.empreend.cdEmpreendView', obraCod);

    log("FORECAST", `Preenchendo Departamento: ${departmentValue}`);
    await safeFillAndTab(page, frame, 'id=obraContrato.cdDepartPrevisao', departmentValue);

    log("FORECAST", "Adicionando parcela...");
    await safeClick(page, frame, '#btNovaLinhaApropDest, input[name="propertyDest"][value="Adicionar"]');

    const row = await getLatestForecastRow(frame);

    const dtInput = row.locator('input[name^="rowParcelaAberta["][name$="].dtVencimento"]').first();
    const peInput = row.locator('input[name^="rowParcelaAberta["][name$="].peParcela"]').first();

    await dtInput.waitFor({ state: "visible", timeout: 30000 });
    await dtInput.scrollIntoViewIfNeeded().catch(() => { });
    await dtInput.click().catch(() => { });
    await dtInput.fill("");
    await dtInput.fill(dtVencimento);
    await dtInput.press("Tab").catch(() => { });
    await waitUiStability(page);

    log("FORECAST", `Preenchendo vencimento real do boleto: ${dtVencimento}`);
    log("FORECAST", `Preenchendo percentual da parcela: ${percentualParcela}%`);

    await peInput.waitFor({ state: "visible", timeout: 30000 });
    await peInput.scrollIntoViewIfNeeded().catch(() => { });
    await peInput.click().catch(() => { });
    await peInput.fill("");
    await peInput.fill(String(percentualParcela));
    await peInput.press("Tab").catch(() => { });
    await waitUiStability(page);

    log("FORECAST", "Salvando previsão financeira...");
    await safeClick(page, frame, 'input[name="pbSalvar"][value="Salvar"]');
    await waitForPageSettled(page);
    await closeBlockingPopups(page);
    await getMainFrame(page);

    success("FORECAST", "Etapa 3 concluída com sucesso.");
}
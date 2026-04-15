// playwright/modules/sienge/itemsContract.js
import { log, success } from "../../core/logger.js";
import { dismissCommonPopups } from "../../core/popups.js";

const MAIN_IFRAME_SELECTOR = 'iframe[title="iFramePage"]';
const MODAL_IFRAME_SELECTOR = 'iframe#layerFormConsulta';

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
        await closeBlockingPopups(page);
        const r = await waitVisible(target, selector, timeout);
        await r.scrollIntoViewIfNeeded().catch(() => { });
        await r.click(options);
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

async function getContextAfterPlanilhaOpen(page, clickAction) {
    const popupPromise = page.waitForEvent("popup", { timeout: 10000 }).catch(() => null);
    await clickAction();
    const popup = await popupPromise;

    if (popup) {
        await waitForPageSettled(popup);
        await dismissCommonPopups(popup, 3000).catch(() => { });
        return popup;
    }

    return await getMainFrame(page);
}

async function getModalFrame(context, timeout = 30000) {
    const h = await context.waitForSelector(MODAL_IFRAME_SELECTOR, { state: "visible", timeout });
    const f = await h.contentFrame();
    if (!f) throw new Error("Iframe do modal financeiro não encontrado.");
    await f.waitForLoadState("domcontentloaded", { timeout }).catch(() => { });
    return f;
}

function normalizeText(value = "") {
    return String(value)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function normalizeNumericString(value = "") {
    return String(value).replace(/\D/g, "");
}

async function collectBudgetItems(context) {
    const rowSel = 'tr[id^="linhaRowPlanilhaOrc_"]:not([id*="-1"])';
    await context.waitForSelector(rowSel, { state: "visible", timeout: 60000 });

    const rows = context.locator(rowSel);
    const count = await rows.count();
    if (!count) throw new Error("Nenhum item do orçamento carregado.");

    const items = [];

    for (let i = 0; i < count; i++) {
        const row = rows.nth(i);
        const cols = row.locator("td");

        const level = (await cols.nth(2).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        const structure = (await cols.nth(3).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        const serviceCode = (await cols.nth(4).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        const description = (await cols.nth(5).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        const unit = (await cols.nth(6).innerText().catch(() => "")).replace(/\s+/g, " ").trim();

        items.push({
            level,
            structure,
            serviceCode,
            description,
            unit,
            label: `${structure} ${serviceCode} ${description}`.trim(),
            locator: row,
        });
    }

    return items;
}

function normalizeMoneyForSienge(value = "") {
    if (value === null || value === undefined) return "";

    let raw = String(value).trim();
    if (!raw) return "";

    raw = raw.replace(/\s/g, "");

    // Se vier em pt-BR: 1.234,56
    if (raw.includes(",")) {
        raw = raw.replace(/\./g, "").replace(",", ".");
    }

    const n = Number(raw);
    if (!Number.isFinite(n)) return "";

    // Campo do Sienge usa 4 casas decimais e vírgula
    return n.toFixed(4).replace(".", ",");
}

async function safeFillMoneyField(page, target, selector, value, options = {}) {
    const loc = await waitVisible(target, selector, options.timeout ?? 60000);
    const formattedValue = normalizeMoneyForSienge(value);

    if (!formattedValue) {
        throw new Error(`Valor monetário inválido: "${value}"`);
    }

    await loc.scrollIntoViewIfNeeded().catch(() => { });
    await closeBlockingPopups(page);

    await loc.click().catch(() => { });
    await loc.fill("");
    await loc.fill(formattedValue);
    await loc.press("Tab").catch(() => { });

    await waitUiStability(page);

    return formattedValue;
}

function findBudgetItem(items, { code = null, name = null }) {
    if (code) {
        const normalizedCode = String(code).trim();
        const foundByCode = items.find(item => String(item.serviceCode).trim() === normalizedCode);
        if (foundByCode) return foundByCode;
    }

    if (name) {
        const target = normalizeText(name);

        const exact = items.find(item => normalizeText(item.description) === target);
        if (exact) return exact;

        const contains = items.find(item => normalizeText(item.description).includes(target));
        if (contains) return contains;
    }

    return null;
}

async function collectFinanceAccounts(modalFrame) {
    const rowSel = '#tabelaResultado tr:has(input[type="checkbox"])';
    await modalFrame.waitForSelector(rowSel, { state: "visible", timeout: 60000 });

    const rows = modalFrame.locator(rowSel);
    const total = await rows.count();
    if (!total) throw new Error("Nenhuma conta financeira carregada.");

    const accounts = [];

    for (let i = 0; i < total; i++) {
        const row = rows.nth(i);
        const cols = row.locator("td");

        const code = (await cols.nth(1).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        const description = (await cols.nth(3).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        if (!code) continue;

        accounts.push({
            code,
            description,
            label: `${code} - ${description}`,
            checkbox: cols.nth(0).locator('input[type="checkbox"]'),
        });
    }

    return accounts;
}

function findFinanceAccount(accounts, code) {
    if (!code) return null;
    const normalizedCode = String(code).trim();
    return accounts.find(a => String(a.code).trim() === normalizedCode) || null;
}

/**
 * Cadastra os itens do contrato no Sienge.
 * @param {object} page
 * @param {object} params
 */
export async function itemsContract(page, params = {}) {
    const {
        obraCod = "97001",
        unidade = "1",
        itemOrcamento = null,
        itemOrcamentoCode = null,
        contaFinanceira = null,
        percentualAlocacao = "100",
        precoMO = "",
    } = params;

    if (!itemOrcamentoCode && !itemOrcamento) {
        throw new Error("Parâmetro obrigatório ausente: itemOrcamentoCode ou itemOrcamento.");
    }

    if (!contaFinanceira) {
        throw new Error("Parâmetro obrigatório ausente: contaFinanceira.");
    }

    log("ITEMS", "Iniciando Etapa 2...");
    await closeBlockingPopups(page);

    let frame = await getMainFrame(page);

    log("ITEMS", "Acessando aba de Itens...");
    await safeClick(page, frame, 'a:has-text("Itens")');
    await waitVisible(frame, "#btNovaLinhaRow", 60000);

    log("ITEMS", `Obra: ${obraCod} / Unidade: ${unidade}`);
    await safeClick(page, frame, "#btNovaLinhaRow");
    await safeFillAndTab(page, frame, 'id=obraContrato.obra.empreend.cdEmpreendView', obraCod);
    await safeFillAndTab(page, frame, 'id=unidObContratoPK.cdUnidObraContrato', unidade);
    await safeClick(page, frame, "#RowFormConfirmar");
    await safeClick(page, frame, "#botaoSubmit");
    await waitForPageSettled(page);
    await closeBlockingPopups(page);

    frame = await getMainFrame(page);

    // ── Garante que o formulário está salvo antes de abrir a planilha ────────
    // O Sienge às vezes retorna ao modo edição após o submit; se #botaoSubmit
    // ainda existir e estiver visível, salva novamente antes de tentar a planilha.
    for (let saveAttempt = 0; saveAttempt < 3; saveAttempt++) {
        const stillEditing = await frame
            .locator('#botaoSubmit')
            .isVisible({ timeout: 2000 })
            .catch(() => false);
        if (!stillEditing) break;
        log("ITEMS", `Formulário ainda em edição (tentativa ${saveAttempt + 1}), salvando...`);
        await safeClick(page, frame, '#botaoSubmit').catch(() => { });
        await waitForPageSettled(page);
        await closeBlockingPopups(page);
        frame = await getMainFrame(page);
    }

    // ── Abre a planilha com retry ─────────────────────────────────────────────
    log("ITEMS", "Abrindo planilha...");
    let context = null;
    for (let planAttempt = 0; planAttempt < 3; planAttempt++) {
        if (planAttempt > 0) {
            log("ITEMS", `Retentando abertura da planilha (tentativa ${planAttempt + 1})...`);
            await page.waitForTimeout(1000);
            frame = await getMainFrame(page);
        }
        const opened = await getContextAfterPlanilhaOpen(page, async () => {
            await safeClick(page, frame, 'tr#linhaRow_0 img#botaoEditarPlanilha_0');
        });

        const isPlanilha = await opened
            .locator('input[value="Orçamento"]')
            .count()
            .catch(() => 0);

        if (isPlanilha > 0) {
            context = opened;
            break;
        }
    }
    if (!context) throw new Error("Planilha não abriu após 3 tentativas.");

    log("ITEMS", "Acessando orçamento...");
    await safeClick(page, context, 'input[value="Orçamento"]');
    await safeClick(page, context, 'input[value="Consultar"]');

    const budgetItems = await collectBudgetItems(context);

    const selectedItem = findBudgetItem(budgetItems, {
        code: itemOrcamentoCode,
        name: itemOrcamento,
    });

    if (!selectedItem) {
        const available = budgetItems
            .map(i => `[${i.serviceCode || "-"}] ${i.description || "-"}`)
            .join(" | ");

        throw new Error(
            `Item de orçamento não encontrado. code="${itemOrcamentoCode || ""}" name="${itemOrcamento || ""}". Disponíveis: ${available}`
        );
    }

    log(
        "ITEMS",
        `Selecionando item orçamento: código=${selectedItem.serviceCode} estrutura=${selectedItem.structure} descrição=${selectedItem.description}`
    );

    await selectedItem.locator.locator('input[type="checkbox"]').check({ force: true });

    log("ITEMS", "Abrindo modal de Plano Financeiro...");
    const addButton = context.locator('#btProcurarAprFinItemCT, input[value="Adicionar"]').first();
    await addButton.waitFor({ state: "visible", timeout: 30000 });
    await closeBlockingPopups(page);
    await addButton.click();

    const modalFrame = await getModalFrame(context);
    const financeAccounts = await collectFinanceAccounts(modalFrame);

    const selectedAccount = findFinanceAccount(financeAccounts, contaFinanceira);

    if (!selectedAccount) {
        const available = financeAccounts.map(a => a.label).join(" | ");
        throw new Error(
            `Conta financeira não encontrada: "${contaFinanceira}". Disponíveis: ${available}`
        );
    }

    log("ITEMS", `Selecionando conta financeira: ${selectedAccount.label}`);
    await selectedAccount.checkbox.check({ force: true });

    await Promise.allSettled([
        context.waitForSelector(MODAL_IFRAME_SELECTOR, { state: "hidden", timeout: 30000 }),
        modalFrame.locator("#pbSelecionar").click(),
    ]);

    await waitUiStability(page);

    log("ITEMS", `Preenchendo percentual: ${percentualAlocacao}%`);
    await safeFill(
        page,
        context,
        'input[id="aprFinItemCT[0].peApropriado_0"]',
        String(parseInt(percentualAlocacao, 10) || 0)
    );

    log("ITEMS", "Salvando planilha...");
    await safeClick(page, context, 'input[name="pbLimpar"][value="Salvar"]');
    if ("waitForLoadState" in context) {
        await context.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => { });
    }

    await page.waitForTimeout(2000);

    log("ITEMS", "Retornando para Itens do Contrato...");
    await safeClick(page, context, 'a:has-text("Itens do Contrato")');
    await waitForPageSettled(page);
    await closeBlockingPopups(page);

    frame = await getMainFrame(page);

    log("ITEMS", "Abrindo edição do item criado...");
    await safeClick(page, frame, 'img[id="row[0].editar_0"]');

    log("ITEMS", "Preenchendo Quantidade: 1");
    await safeFill(page, frame, '#entity\\.qtContratada', "1");
    await frame.locator('#entity\\.qtContratada').press("Tab");
    await waitUiStability(page);

    const formattedPrecoMO = await safeFillMoneyField(
        page,
        frame,
        '#entity\\.vlPrecoUnitarioMO',
        precoMO
    );

    log("ITEMS", `Preenchendo Preço Unitário MO: ${formattedPrecoMO}`);

    log("ITEMS", "Finalizando contrato...");
    await safeClick(page, frame, "#botaoSubmit");
    await waitForPageSettled(page);
    await closeBlockingPopups(page);

    // ── ADIÇÃO NECESSÁRIA: reidratar o contexto do contrato ──────────────────
    frame = await getMainFrame(page);

    log("ITEMS", "Voltando em Itens do Contrato...");
    await safeClick(page, frame, 'a:has-text("Itens do Contrato")');
    await waitForPageSettled(page);
    await closeBlockingPopups(page);

    frame = await getMainFrame(page);

    log("ITEMS", "Voltando em Obras e Unidades Construtivas...");
    await safeClick(page, frame, 'a:has-text("Obras e Unidades Construtivas")');
    await waitForPageSettled(page);
    await closeBlockingPopups(page);

    await getMainFrame(page);
    // ──────────────────────────────────────────────────────────────────────────

    success("ITEMS", "Fluxo concluído com sucesso.");
}
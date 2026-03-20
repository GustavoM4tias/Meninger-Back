// playwright/modules/sienge/additive.js
import { log, success } from "../../core/logger.js";
import { dismissCommonPopups } from "../../core/popups.js";
import { unlockPlanilha } from "./unlockPlanilha.js";

const CONTRACTS_PAGE_URL =
    "https://menin.sienge.com.br/sienge/8/index.html#/suprimentos/contratos-e-medicoes/contratos/cadastros";
const MAIN_IFRAME_SELECTOR = 'iframe[title="iFramePage"]';
const MODAL_IFRAME_SELECTOR = 'iframe#layerFormConsulta';

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
    throw new Error(`Iframe principal não encontrado após ${timeout}ms. Último erro: ${lastErr?.message}`);
}

async function waitVisible(target, selector, timeout = 60000) {
    const l = target.locator(selector);
    await l.waitFor({ state: "visible", timeout });
    return l;
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
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await closeBlockingPopups(page);
    try {
        await loc.click(options);
    } catch (err) {
        if (!isPointerInterceptError(err)) throw err;
        await closeBlockingPopups(page);
        const r = await waitVisible(target, selector, timeout);
        await r.scrollIntoViewIfNeeded().catch(() => {});
        await r.click(options);
    }
    await waitUiStability(page);
    return loc;
}

async function safeFill(page, target, selector, value, options = {}) {
    const loc = await waitVisible(target, selector, options.timeout ?? 60000);
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await closeBlockingPopups(page);
    await loc.click().catch(() => {});
    await loc.fill("");
    await loc.fill(String(value ?? ""));
    return loc;
}

async function safeFillAndTab(page, target, selector, value, options = {}) {
    const loc = await safeFill(page, target, selector, value, options);
    await loc.press("Tab").catch(() => {});
    await waitUiStability(page);
    return loc;
}

function normalizeMoneyForSienge(value = "") {
    if (value === null || value === undefined) return "";
    let raw = String(value).trim();
    if (!raw) return "";
    raw = raw.replace(/\s/g, "");
    if (raw.includes(",")) {
        raw = raw.replace(/\./g, "").replace(",", ".");
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return "";
    return n.toFixed(4).replace(".", ",");
}

async function safeFillMoneyField(page, target, selector, value, options = {}) {
    const loc = await waitVisible(target, selector, options.timeout ?? 60000);
    const formattedValue = normalizeMoneyForSienge(value);
    if (!formattedValue) {
        throw new Error(`Valor monetário inválido: "${value}"`);
    }
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await closeBlockingPopups(page);
    await loc.click().catch(() => {});
    await loc.fill("");
    await loc.fill(formattedValue);
    await loc.press("Tab").catch(() => {});
    await waitUiStability(page);
    return formattedValue;
}

async function getContextAfterPlanilhaOpen(page, clickAction) {
    const popupPromise = page.waitForEvent("popup", { timeout: 10000 }).catch(() => null);
    await clickAction();
    const popup = await popupPromise;
    if (popup) {
        await waitForPageSettled(popup);
        await dismissCommonPopups(popup, 3000).catch(() => {});
        return popup;
    }
    return await getMainFrame(page);
}

async function getModalFrame(context, timeout = 30000) {
    const h = await context.waitForSelector(MODAL_IFRAME_SELECTOR, { state: "visible", timeout });
    const f = await h.contentFrame();
    if (!f) throw new Error("Iframe do modal financeiro não encontrado.");
    await f.waitForLoadState("domcontentloaded", { timeout }).catch(() => {});
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
        const structure = (await cols.nth(3).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        const serviceCode = (await cols.nth(4).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        const description = (await cols.nth(5).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        items.push({ structure, serviceCode, description, locator: row });
    }
    return items;
}

function findBudgetItem(items, { code = null, name = null }) {
    if (code) {
        const found = items.find(item => String(item.serviceCode).trim() === String(code).trim());
        if (found) return found;
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

function getTodayFormatted() {
    const now = new Date();
    const d = String(now.getDate()).padStart(2, "0");
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const y = now.getFullYear();
    return `${d}/${m}/${y}`;
}

// ── main export ────────────────────────────────────────────────────────────────

/**
 * Cria um aditivo para um contrato existente no Sienge.
 *
 * @param {object} page
 * @param {object} params
 * @param {string} params.documentType      - Tipo do documento (ex: "CT", "PCEF", "CPC")
 * @param {string} params.contractNumber    - Número do contrato (ex: "4903")
 * @param {string} params.obraCod          - Código da obra / centro de custo
 * @param {string} params.descricao         - Descrição/observação do aditivo
 * @param {string} [params.dataAditivo]     - Data DD/MM/YYYY (padrão: hoje)
 * @param {string} [params.itemOrcamentoCode] - Código do item de orçamento
 * @param {string} [params.itemOrcamento]   - Nome do item de orçamento
 * @param {string} params.contaFinanceira   - Código da conta financeira
 * @param {string} [params.percentualAlocacao] - Percentual (padrão: "100")
 * @param {string} params.precoMO           - Preço unitário mão de obra
 */
export async function createAdditive(page, params = {}) {
    const {
        documentType = "PCEF",
        contractNumber = "",
        obraCod = "",
        descricao = "ADITIVO AUTOMÁTICO PAYMENT FLOW",
        dataAditivo = getTodayFormatted(),
        itemOrcamentoCode = null,
        itemOrcamento = null,
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

    // ── PRÉ-FASE: libera qualquer alocação prévia da planilha ────────────────
    log("ADDITIVE", `Iniciando criação de aditivo — ${documentType}/${contractNumber}`);
    log("ADDITIVE", "Liberando alocação prévia da planilha (preventivo)...");
    await unlockPlanilha(page, { contractNumber, documentType }).catch((err) => {
        log("ADDITIVE", `Aviso no desbloqueio preventivo: ${err.message}`);
    });

    // Quando a planilha está alocada, reinicia o fluxo inteiro desde FASE 1.
    const MAX_FULL_RETRIES = 3;

    for (let fullAttempt = 1; fullAttempt <= MAX_FULL_RETRIES; fullAttempt++) {
        if (fullAttempt > 1) {
            log("ADDITIVE", `[retry ${fullAttempt}/${MAX_FULL_RETRIES}] Reiniciando fluxo completo após desbloqueio da planilha...`);
        }

        // ── FASE 1: Buscar contrato na listagem (React SPA) ──────────────────────
        log("ADDITIVE", `Navegando para a listagem de contratos...`);
        await page.goto(CONTRACTS_PAGE_URL, { waitUntil: "domcontentloaded" });
        await waitForPageSettled(page);
        await closeBlockingPopups(page);

        // Preencher campo Documento (MUI Autocomplete)
        // O Autocomplete demora alguns ms para filtrar — aguarda a opção exata aparecer
        log("ADDITIVE", `Preenchendo Documento: ${documentType}`);
        const docInput = page.locator('.MuiAutocomplete-root[name="cdDocumento"] input[type="text"]');
        await docInput.waitFor({ state: "visible", timeout: 30000 });
        await docInput.click();
        await docInput.fill("");
        await docInput.type(documentType, { delay: 1200 }); // digita devagar para o filtro reagir

        // Aguarda o listbox aparecer e procura a opção que corresponde exatamente ao documentType
        const listbox = page.locator('[role="listbox"]');
        await listbox.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});

        // Tenta clicar na opção cujo texto exato seja o documentType
        const exactOption = page.locator(`[role="option"]`).filter({ hasText: new RegExp(`^${documentType}$`) });
        const hasExact = await exactOption.count().then(c => c > 0).catch(() => false);
        if (hasExact) {
            await exactOption.first().click();
        } else {
            // Fallback: primeira opção visível
            const firstOption = page.locator('[role="option"]').first();
            const hasAny = await firstOption.isVisible({ timeout: 3000 }).catch(() => false);
            if (hasAny) {
                await firstOption.click();
            } else {
                await docInput.press("Tab");
            }
        }
        await page.waitForTimeout(400);

        // Preencher Número
        log("ADDITIVE", `Preenchendo Número: ${contractNumber}`);
        const numInput = page.locator('input[name="nuContrato"]');
        await numInput.waitFor({ state: "visible", timeout: 10000 });
        await numInput.fill(String(contractNumber));

        // Clicar em Consultar
        const consultarBtn = page.locator('button[type="submit"]').last();
        await consultarBtn.waitFor({ state: "visible", timeout: 10000 });
        await consultarBtn.click();

        // Aguardar resultados na grid
        log("ADDITIVE", "Aguardando resultados da consulta...");
        await page.waitForSelector('.MuiDataGrid-row', { state: "visible", timeout: 30000 });
        await page.waitForTimeout(1000);

        // Debug: salva screenshot e loga todos os aria-labels de botões na grid
        await page.screenshot({ path: '/tmp/additive_grid_debug.png' }).catch(() => {});
        const gridButtons = await page.evaluate(() => {
            const btns = document.querySelectorAll('.MuiDataGrid-row button, .MuiDataGrid-row a[role="button"]');
            return [...btns].map(b => ({
                tag: b.tagName,
                ariaLabel: b.getAttribute('aria-label'),
                title: b.getAttribute('title'),
                text: b.innerText?.trim().slice(0, 40),
                visible: b.offsetParent !== null,
            }));
        });
        log("ADDITIVE", `Botões encontrados na grid: ${JSON.stringify(gridButtons)}`);

        // Seletor flexível: aria-label contendo "ditar" (Editar/Edit) OU title OU ícone de lápis
        const editSelectors = [
            '[aria-label="Editar contrato"]',
            '[aria-label*="ditar"]',
            '[aria-label*="Edit"]',
            '[title*="ditar"]',
            '[title*="Edit"]',
            '.MuiDataGrid-row button:has(svg[data-testid="EditIcon"])',
            '.MuiDataGrid-row button:has(svg[data-testid="ModeEditIcon"])',
        ];

        let editBtn = null;
        for (const sel of editSelectors) {
            const count = await page.locator(sel).count();
            if (count > 0) {
                editBtn = page.locator(sel).first();
                log("ADDITIVE", `Botão editar encontrado com seletor: ${sel}`);
                break;
            }
        }

        if (!editBtn) {
            throw new Error(
                `Botão de editar contrato não encontrado na grid. Botões disponíveis: ${JSON.stringify(gridButtons)}`
            );
        }

        await editBtn.scrollIntoViewIfNeeded().catch(() => {});
        await editBtn.click({ force: true });

        // Aguardar navegação para página antiga do Sienge (com iframe)
        log("ADDITIVE", "Aguardando carregamento da página de edição...");
        await page
            .waitForURL(url => !url.includes('contratos/cadastros'), { timeout: 20000 })
            .catch(() => {});
        await waitForPageSettled(page);
        await closeBlockingPopups(page);

        // ── FASE 2: Navegar para aba Aditivos ────────────────────────────────────
        let frame = await getMainFrame(page);

        log("ADDITIVE", "Clicando em Aditivos...");
        const aditivosLink = frame.locator('a:has-text("Aditivos")');
        await aditivosLink.waitFor({ state: "visible", timeout: 30000 });
        await aditivosLink.click();
        await waitForPageSettled(page);
        await closeBlockingPopups(page);
        frame = await getMainFrame(page);

        // ── FASE 3: Criar novo aditivo ───────────────────────────────────────────
        log("ADDITIVE", "Clicando em Novo...");
        const novoBtn = frame.locator('input[value="Novo"][onclick*="addAditivo"]');
        await novoBtn.waitFor({ state: "visible", timeout: 30000 });
        await novoBtn.scrollIntoViewIfNeeded().catch(() => {});
        await novoBtn.click();

        // addAditivo() carrega via AJAX no iframe — faz polling até o formulário aparecer.
        log("ADDITIVE", "Aguardando formulário de novo aditivo...");
        let formLoaded = false;
        for (let attempt = 0; attempt < 20 && !formLoaded; attempt++) {
            await page.waitForTimeout(1500);
            frame = await getMainFrame(page);
            const count = await frame
                .locator('input[name="entity.obraContrato.obra.empreend.cdEmpreendView"]')
                .count()
                .catch(() => 0);
            if (count > 0) formLoaded = true;
        }
        if (!formLoaded) {
            throw new Error('Formulário de novo aditivo não apareceu após clicar em Novo (30s)');
        }

        log("ADDITIVE", `Preenchendo Obra: ${obraCod}`);
        await safeFillAndTab(
            page,
            frame,
            'input[name="entity.obraContrato.obra.empreend.cdEmpreendView"]',
            obraCod
        );

        log("ADDITIVE", "Preenchendo Descrição...");
        await safeFill(page, frame, 'textarea[name="entity.deAditivo"]', descricao);

        log("ADDITIVE", `Preenchendo Data: ${dataAditivo}`);
        await safeFill(page, frame, 'input[name="entity.dtAditivo"]', dataAditivo);

        log("ADDITIVE", "Salvando aditivo...");
        await safeClick(page, frame, '#botaoSubmit');
        await waitForPageSettled(page);
        await closeBlockingPopups(page);
        frame = await getMainFrame(page);

        // Aguarda os itens da planilha carregarem completamente após o AJAX do save
        log("ADDITIVE", "Aguardando itens da unidade/obra após salvamento...");
        await frame.waitForSelector('tr#linhaUnidObContrato_0', { state: 'visible', timeout: 60000 });
        await frame.waitForTimeout(1500);

        // ── FASE 4: Abrir planilha ────────────────────────────────────────────────
        log("ADDITIVE", "Abrindo planilha...");
        page._planilhaAlocadaDetected = false;

        const context = await getContextAfterPlanilhaOpen(page, async () => {
            await safeClick(page, frame, 'tr#linhaUnidObContrato_0 img[alt="Editar planilha"]');
        });

        if (page._planilhaAlocadaDetected) {
            if (fullAttempt === MAX_FULL_RETRIES) {
                throw new Error(
                    `Planilha do contrato ${documentType}/${contractNumber} continua alocada após ${MAX_FULL_RETRIES} tentativas de desbloqueio.`
                );
            }
            log("ADDITIVE", `[tentativa ${fullAttempt}/${MAX_FULL_RETRIES}] Planilha alocada — desbloqueando e reiniciando fluxo do início...`);
            await unlockPlanilha(page, { contractNumber, documentType });
            await page.waitForTimeout(3000);
            continue; // volta ao topo do loop — reinicia desde FASE 1
        }

        // ── FASE 5: Orçamento → Consultar → selecionar item ─────────────────────
        log("ADDITIVE", "Clicando em Orçamento...");
        await safeClick(page, context, 'input[value="Orçamento"]');

        // Se pedir para selecionar um registro, seleciona o primeiro
        const consultarOrcVisible = await context
            .locator('input[value="Consultar"]')
            .isVisible({ timeout: 5000 })
            .catch(() => false);

        if (!consultarOrcVisible) {
            log("ADDITIVE", "Selecionando primeiro registro antes de prosseguir com Orçamento...");
            const firstCheckbox = context
                .locator('tr[id^="linhaRow_0"] input[type="checkbox"]')
                .first();
            const hasFirstRow = await firstCheckbox.isVisible({ timeout: 3000 }).catch(() => false);
            if (hasFirstRow) {
                await firstCheckbox.check({ force: true }).catch(() => {});
                await safeClick(page, context, 'input[value="Orçamento"]');
            }
        }

        await safeClick(page, context, 'input[value="Consultar"]');

        // Aguarda a grid do orçamento carregar completamente via AJAX
        await context.waitForSelector(
            'tr[id^="linhaRowPlanilhaOrc_"]:not([id*="-1"])',
            { state: "visible", timeout: 30000 }
        );
        await context.waitForTimeout(2000);

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

        log("ADDITIVE", `Selecionando item: ${selectedItem.serviceCode} - ${selectedItem.description}`);
        await selectedItem.locator.locator('input[type="checkbox"]').check({ force: true });

        // Adicionar conta financeira
        log("ADDITIVE", "Abrindo modal de Plano Financeiro...");
        const addButton = context.locator('#btProcurarAprFinItemCT, input[value="Adicionar"]').first();
        await addButton.waitFor({ state: "visible", timeout: 30000 });
        await closeBlockingPopups(page);
        await addButton.click();

        const modalFrame = await getModalFrame(context);

        // Aguarda a lista de contas financeiras carregar completamente
        await modalFrame.waitForSelector(
            '#tabelaResultado tr:has(input[type="checkbox"])',
            { state: "visible", timeout: 30000 }
        );
        await modalFrame.waitForTimeout(2000);

        const financeAccounts = await collectFinanceAccounts(modalFrame);
        const selectedAccount = findFinanceAccount(financeAccounts, contaFinanceira);

        if (!selectedAccount) {
            const available = financeAccounts.map(a => a.label).join(" | ");
            throw new Error(
                `Conta financeira não encontrada: "${contaFinanceira}". Disponíveis: ${available}`
            );
        }

        log("ADDITIVE", `Selecionando conta: ${selectedAccount.label}`);
        await selectedAccount.checkbox.check({ force: true });

        await Promise.allSettled([
            context.waitForSelector(MODAL_IFRAME_SELECTOR, { state: "hidden", timeout: 30000 }),
            modalFrame.locator("#pbSelecionar").click(),
        ]);
        await waitUiStability(page);

        log("ADDITIVE", `Preenchendo percentual: ${percentualAlocacao}%`);
        await safeFill(
            page,
            context,
            'input[id="aprFinItemCT[0].peApropriado_0"]',
            String(parseInt(percentualAlocacao, 10) || 0)
        );

        log("ADDITIVE", "Salvando planilha...");
        await safeClick(page, context, 'input[name="pbLimpar"][value="Salvar"]');
        if ("waitForLoadState" in context) {
            await context.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        }
        await page.waitForTimeout(2000);

        // ── FASE 6: Itens do Aditivo → selecionar novo item → preencher preço ───
        log("ADDITIVE", "Acessando Itens do Aditivo...");
        const itensAditivoLink = context.locator('a:has-text("Itens do Aditivo")');
        await itensAditivoLink.waitFor({ state: "visible", timeout: 30000 });
        await itensAditivoLink.click();
        await waitForPageSettled(page);
        await closeBlockingPopups(page);

        // Em aditivos, o item 0 é sempre o item base/pai do orçamento.
        // O item recém criado fica sempre no índice 1.
        const targetRowIndex = 1;
        log("ADDITIVE", `Abrindo edição do item ${targetRowIndex}...`);
        await safeClick(
            page,
            context,
            `img[id="row[${targetRowIndex}].editar_${targetRowIndex}"]`
        );
        await waitForPageSettled(page);

        // Preencher Quantidade (sempre 1 — saldo = 1 × preço)
        // Campo usa formato numérico com 4 casas e dispara blur/recalc — usa safeFillMoneyField
        log("ADDITIVE", "Preenchendo Quantidade: 1");
        await safeFillMoneyField(page, context, 'input[name="itemAditivo.qtAditada"]', "1");

        // Preencher Preço de mão de obra
        log("ADDITIVE", `Preenchendo Preço MO: ${precoMO}`);
        await safeFillMoneyField(
            page,
            context,
            'input[name="itemAditivo.vlPrecoUnitarioMO"]',
            precoMO
        );

        // Salvar item
        log("ADDITIVE", "Salvando item do aditivo...");
        await safeClick(page, context, '#botaoSubmit');
        await waitForPageSettled(page);
        await closeBlockingPopups(page);

        success(
            "ADDITIVE",
            `Aditivo criado com sucesso para o contrato ${documentType}/${contractNumber}.`
        );
        return; // saiu com sucesso — não precisa de mais tentativas
    }
}

// playwright/modules/sienge/measurement.js
import { log, success } from "../../core/logger.js";
import { dismissCommonPopups } from "../../core/popups.js";
import { unlockPlanilha } from "./unlockPlanilha.js";
import { assertEnabledOrExplain } from "../../core/formDiagnostics.js";

const MEASUREMENTS_PAGE_URL =
    "https://menin.sienge.com.br/sienge/8/index.html#/suprimentos/contratos-e-medicoes/medicoes/cadastros";
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
    throw new Error(`Iframe principal não encontrado após ${timeout}ms. Último erro: ${lastErr?.message}`);
}

async function waitVisible(target, selector, timeout = 60000) {
    const l = target.locator(selector);
    await l.waitFor({ state: "visible", timeout });
    return l;
}

async function closeBlockingPopups(page) {
    await dismissCommonPopups(page, 3000).catch(() => {});

    // ── MUI Dialog/Modal (MuiDialog-root intercepta pointer events) ────────
    const muiSelectors = [
        'div.MuiDialog-root',
        'div.MuiModal-root:not([aria-hidden="true"])',
    ];
    for (const sel of muiSelectors) {
        const dialog = page.locator(sel).first();
        if (await dialog.count().catch(() => 0) === 0) continue;
        if (!await dialog.isVisible().catch(() => false)) continue;

        // Tenta fechar pelo botão interno (X, Fechar, Cancelar)
        const closeBtn = dialog.locator([
            'button[aria-label*="lose"]',
            'button[aria-label*="echar"]',
            'button:has-text("Fechar")',
            'button:has-text("Cancelar")',
            'button:has-text("Não")',
            '[class*="closeButton"]',
            '[class*="close-button"]',
        ].join(', ')).first();

        if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
            log("POPUP", "Fechando MuiDialog via botão interno...");
            await closeBtn.click({ force: true, timeout: 1000 }).catch(() => {});
        } else {
            log("POPUP", "Fechando MuiDialog via Escape...");
            await page.keyboard.press("Escape").catch(() => {});
        }
        await page.waitForTimeout(400);
    }

    // ── MUI Snackbar (flutua sobre a página e intercepta cliques) ─────────
    const snackbarCloseBtn = page.locator('button[data-testid="snackbar-button-close"]');
    const snackbarCount = await snackbarCloseBtn.count().catch(() => 0);
    for (let i = 0; i < snackbarCount; i++) {
        const btn = snackbarCloseBtn.nth(i);
        if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
            log("POPUP", "Fechando MUI Snackbar...");
            await btn.click({ force: true, timeout: 1000 }).catch(() => {});
            await page.waitForTimeout(300);
        }
    }

    // ── Overlays jQuery / Beamer ───────────────────────────────────────────
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

/**
 * Preenche um campo numérico com 2 casas decimais (formato Sienge: "7500,00").
 * Dispara Tab para acionar os handlers onblur da grade.
 */
async function safeFillMoney2(page, target, selector, value) {
    const loc = await waitVisible(target, selector, 60000);
    const n = Number(String(value).replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(n)) throw new Error(`Valor monetário inválido: "${value}"`);
    const formatted = n.toFixed(2).replace(".", ",");

    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await closeBlockingPopups(page);
    await loc.click().catch(() => {});
    await loc.fill("");
    await loc.fill(formatted);
    await loc.press("Tab").catch(() => {});
    await waitUiStability(page);
    return formatted;
}

/**
 * Preenche um MUI Autocomplete, aguarda as opções e seleciona a melhor correspondência.
 * matchText é uma string ou RegExp usada para filtrar as opções.
 */
async function fillAutocomplete(page, fieldName, searchText, matchText, container = null, { strict = false } = {}) {
    const root = container ?? page;
    const input = root.locator(`[name="${fieldName}"] input[type="text"]`);
    await input.waitFor({ state: "visible", timeout: 20000 });
    await input.click();
    await input.fill("");
    await input.type(String(searchText), { delay: 400 });

    // Aguarda o listbox carregar
    const listbox = page.locator('[role="listbox"]');
    await listbox.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);

    // Tenta encontrar opção com o texto de match
    let selected = false;
    if (matchText) {
        const pattern = matchText instanceof RegExp ? matchText : new RegExp(String(matchText).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        const option = page.locator('[role="option"]').filter({ hasText: pattern }).first();
        if (await option.isVisible({ timeout: 3000 }).catch(() => false)) {
            await option.click();
            selected = true;
        }
    }

    // Estrito: sem a opção certa, NÃO cai na primeira da lista (medir no
    // contrato errado) nem segue com o campo vazio (Salvar fica desabilitado
    // e o erro vira um timeout sem explicação - lançamentos 70 e 71).
    if (!selected && strict) {
        const opts = await page.locator('[role="option"]').allInnerTexts().catch(() => []);
        // Uma única opção para a busca exata não é ambígua (o texto pode vir
        // num formato que o padrão não previu, ex.: "32 - CTPJ").
        if (opts.length === 1) {
            await page.locator('[role="option"]').first().click();
            log("AUTOCOMPLETE", `${fieldName}: opção única aceita - "${opts[0].replace(/\s+/g, ' ').trim()}"`);
            await page.waitForTimeout(400).catch(() => {});
            return true;
        }
        const vistas = opts.slice(0, 5).map(s => s.replace(/\s+/g, ' ').trim()).join(' | ') || 'nenhuma';
        await page.keyboard.press("Escape").catch(() => {});
        throw new Error(`"${searchText}" não apareceu na busca do campo ${fieldName} da medição. Opções vistas: ${vistas}.`);
    }

    if (!selected) {
        const first = page.locator('[role="option"]').first();
        if (await first.isVisible({ timeout: 3000 }).catch(() => false)) {
            await first.click();
            selected = true;
        }
    }

    if (!selected) {
        await input.press("Tab");
    }

    await page.waitForTimeout(400).catch(() => {}); // page pode navegar após seleção
    return selected;
}

// ── Tela NOVA de edição da medição (set/2026) ─────────────────────────────────
//
// Desde set/2026 o Sienge abre a medição salva na tela nova
// (#/suprimentos/contratos-e-medicoes/medicoes/editar/DOC/NUM/OBRA/MED), com os
// itens numa grade MUI na própria página - sem o iframe legado nem o link
// "Itens". O robô esperava o iframe e caía com "Frame was detached" DEPOIS de a
// medição já existir, deixando-a com R$ 0 (CT/5082 #11, 30/09/2026).

const EDIT_URL_RE = /\/medicoes\/editar\/([^/]+)\/([^/]+)\/(\d+)\/(\d+)/;

function parseMoneyBR(txt) {
    const s = String(txt || "").replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

// Os avisos da tela nova chegam DEPOIS do carregamento (vídeo "Conheça a nova
// tela", pedido de notificação push, dica "Entendi", Beamer) e cobrem os
// botões. Fecha em rodadas até uma rodada não achar mais nada.
async function removeOverlays(page, { rounds = 4 } = {}) {
    for (let r = 0; r < rounds; r++) {
        await page.evaluate(() => {
            for (const s of ["#beamerOverlay", "#beamerAnnouncementPopup", ".beamerAnnouncementPopupContainer", "#beamerNews"]) {
                document.querySelectorAll(s).forEach((e) => e.remove());
            }
        }).catch(() => {});
        let fechou = false;
        for (const txt of ["FECHAR", "NÃO, OBRIGADO", "ENTENDI"]) {
            const b = page.locator(`button:has-text("${txt}")`).filter({ visible: true }).first();
            if (await b.isVisible({ timeout: r === 0 ? 2500 : 1200 }).catch(() => false)) {
                await b.click({ timeout: 3000 }).catch(() => {});
                fechou = true;
                await page.waitForTimeout(500);
            }
        }
        if (!fechou && r > 0) break;
    }
}

/**
 * Passo "Anexos" da tela nova (tem de estar visível): escolhe os PDFs, clica em
 * "Adicionar arquivos" e confere cada nome na tabela de anexos. Escolher sem
 * adicionar só deixa o arquivo num chip - o Sienge não grava.
 * @returns {number} quantos apareceram na tabela
 */
export async function attachFilesNewUi(page, files = []) {
    if (!files.length) return 0;
    await removeOverlays(page);
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 15000 });
    await fileInput.setInputFiles(files);
    await page.waitForTimeout(1000);
    const adicionar = page.getByRole("button", { name: "ADICIONAR ARQUIVOS" }).first();
    await adicionar.waitFor({ state: "visible", timeout: 10000 });
    await adicionar.click();
    await waitForPageSettled(page);
    await page.waitForTimeout(2500);
    await removeOverlays(page);

    let ok = 0;
    for (const f of files) {
        const nome = String(f).split(/[\\/]/).pop().replace(/\.pdf$/i, "");
        const naTabela = await page.locator('[role="row"]').filter({ hasText: nome }).count().catch(() => 0);
        if (naTabela) ok++;
        else log("MEASUREMENT", `Anexo "${nome}" não apareceu na tabela de anexos.`);
    }
    log("MEASUREMENT", `${ok}/${files.length} anexo(s) gravados na medição.`);
    return ok;
}

/** Número da medição a partir da URL da tela nova (null se não estiver nela). */
export function measurementNumberFromUrl(url) {
    const m = EDIT_URL_RE.exec(String(url || ""));
    return m ? Number(m[4]) : null;
}

/** Abre direto a tela nova de edição de uma medição existente. */
export async function openMeasurementEditor(page, { documentType, contractNumber, obraCod, measurementNumber }) {
    const url = `https://menin.sienge.com.br/sienge/8/index.html#/suprimentos/contratos-e-medicoes/medicoes/editar/${documentType}/${contractNumber}/${obraCod}/${measurementNumber}`;
    log("MEASUREMENT", `Abrindo medição ${documentType}/${contractNumber} #${measurementNumber} na tela nova...`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await waitForPageSettled(page);
    await page.waitForTimeout(2500);
    await removeOverlays(page);
}

/**
 * Preenche o valor da medição na tela NOVA e salva o passo "Itens do contrato".
 * Confere o valor na célula ANTES de salvar: se não bater, lança sem salvar.
 *
 * @param {object} params
 * @param {string|number} params.value      - valor a medir
 * @param {string}        [params.itemRef]  - código de referência da linha (ex.: "01.001.001.001")
 * @param {string[]}      [params.files]    - caminhos de PDFs para o passo "Anexos"
 * @returns {{ measurementNumber: number|null, attached: number }}
 */
export async function fillMeasurementNewUi(page, { value, itemRef = null, files = [] } = {}) {
    const alvo = Number(String(value).replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(alvo) || alvo <= 0) throw new Error(`Valor da medição inválido: "${value}"`);

    // A grade e os avisos chegam depois da URL: espera a grade, fecha os avisos e
    // tenta o clique de novo se algum aviso ainda cobrir o botão.
    await page.locator('[role="grid"]').first().waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await removeOverlays(page);
    log("MEASUREMENT", "Tela nova: selecionando Valores monetários...");
    const valoresBtn = page.getByRole("button", { name: "Valores monetários" }).first();
    for (let t = 1; ; t++) {
        try {
            await valoresBtn.click({ timeout: 8000 });
            break;
        } catch (err) {
            if (t >= 4) throw err;
            log("MEASUREMENT", `Valores monetários coberto (tentativa ${t}); fechando avisos...`);
            await removeOverlays(page);
            await page.keyboard.press("Escape").catch(() => {});
        }
    }
    await page.waitForTimeout(2000);
    await removeOverlays(page);

    // Linhas folha (com preço unitário) e o saldo de cada uma.
    const linhas = await page.locator('[role="row"]').evaluateAll((rows) => rows.map((r, idx) => {
        const cel = (f) => r.querySelector(`[data-field="${f}"]`)?.innerText?.trim() || "";
        return { idx, ref: cel("codigoReferencia"), label: cel("labelItem"), preco: cel("precoUnitarioTotal"),
            contratado: cel("valorContratado"), acumulado: cel("valorMedidoAcumuladoAnterior") };
    }).filter((l) => l.ref && l.preco));
    const folhas = linhas.map((l) => ({ ...l, saldo: (parseMoneyBR(l.contratado) || 0) - (parseMoneyBR(l.acumulado) || 0) }));
    if (!folhas.length) throw new Error("Tela nova da medição: nenhuma linha de item encontrada na grade.");

    let escolhida = itemRef ? folhas.find((l) => l.ref === itemRef) : null;
    if (itemRef && !escolhida) throw new Error(`Item ${itemRef} não está na grade da medição (há: ${folhas.map((l) => l.ref).join(", ")}).`);
    if (!escolhida) {
        const suficientes = folhas.filter((l) => l.saldo + 0.005 >= alvo).sort((a, b) => a.saldo - b.saldo);
        if (!suficientes.length) throw new Error(`Nenhum item com saldo para R$ ${alvo.toFixed(2)} (saldos: ${folhas.map((l) => `${l.ref} R$ ${l.saldo.toFixed(2)}`).join("; ")}).`);
        if (suficientes.length > 1) {
            throw new Error(`Mais de um item com saldo para R$ ${alvo.toFixed(2)} (${suficientes.map((l) => l.ref).join(", ")}): informe o item.`);
        }
        escolhida = suficientes[0];
    }
    log("MEASUREMENT", `Item: ${escolhida.ref} - ${escolhida.label.slice(0, 60)} | saldo R$ ${escolhida.saldo.toFixed(2)}`);

    const row = page.locator('[role="row"]').filter({ has: page.locator(`[data-field="codigoReferencia"]`, { hasText: new RegExp(`^${escolhida.ref.replace(/\./g, "\\.")}$`) }) }).first();
    const cell = row.locator('[data-field="valorMedido"]');
    await cell.scrollIntoViewIfNeeded().catch(() => {});
    const formatted = alvo.toFixed(2).replace(".", ",");

    const tentar = async (modo) => {
        await cell.dblclick();
        const input = cell.locator("input");
        await input.waitFor({ state: "visible", timeout: 8000 });
        if (modo === "fill") {
            await input.fill(formatted);
        } else {
            await input.press("Control+A");
            await input.pressSequentially(alvo.toFixed(2).replace(/\D/g, ""), { delay: 60 });
        }
        await input.press("Enter");
        await page.waitForTimeout(900);
        return parseMoneyBR(await cell.innerText().catch(() => ""));
    };
    let lido = await tentar("fill");
    if (lido == null || Math.abs(lido - alvo) > 0.009) {
        log("MEASUREMENT", `Valor lido R$ ${lido} após preencher; tentando digitação...`);
        lido = await tentar("digitos");
    }
    if (lido == null || Math.abs(lido - alvo) > 0.009) {
        throw new Error(`O valor não entrou na grade da medição (esperado R$ ${formatted}, ficou R$ ${lido}). Nada foi salvo.`);
    }
    log("MEASUREMENT", `Valor conferido na grade: R$ ${formatted}`);

    const salvarContinuar = page.getByRole("button", { name: "SALVAR E CONTINUAR" }).first();
    await assertEnabledOrExplain(salvarContinuar, page.locator("main, body").first(), "Salvar e continuar");
    await salvarContinuar.click();
    await waitForPageSettled(page);
    await page.waitForTimeout(2500);
    await removeOverlays(page);
    log("MEASUREMENT", "Itens salvos.");

    // Passo "Anexos": sobe os PDFs pela própria tela (a API de anexo do Sienge
    // recusa com 403 para o usuário da integração).
    let attached = 0;
    if (files.length) {
        attached = await attachFilesNewUi(page, files).catch((err) => {
            log("MEASUREMENT", `Passo Anexos falhou (a medição já está salva): ${err.message.split("\n")[0]}`);
            return 0;
        });
    }

    return { measurementNumber: measurementNumberFromUrl(page.url()), attached };
}

// ── main export ────────────────────────────────────────────────────────────────

/**
 * Cria uma medição para um contrato existente no Sienge.
 *
 * @param {object} page
 * @param {object} params
 * @param {string} params.documentType      - Tipo do documento (ex: "CT")
 * @param {string} params.contractNumber    - Número do contrato (ex: "5752")
 * @param {string} params.obraCod           - Código da obra (erpId)
 * @param {string} params.dataVencimento    - DD/MM/YYYY — data de vencimento (boleto)
 * @param {string|number} params.value      - Valor da medição (mesmo do boleto/lançamento)
 * @param {number} [params.targetRowIndex]  - Índice 1-based do item editável a preencher (padrão: 1)
 * @returns {{ measurementNumber: number|null }}
 */
export async function createMeasurement(page, params = {}) {
    const {
        documentType = "CT",
        contractNumber = "",
        obraCod = "",
        dataVencimento = "",
        value = "",
        targetRowIndex = 1,
        // Tela nova: código da linha a medir (opcional) e PDFs para o passo Anexos.
        itemRef = null,
        files = [],
    } = params;

    // ── PRÉ-FASE: libera qualquer alocação prévia da planilha ────────────────
    log("MEASUREMENT", `Iniciando criação de medição — ${documentType}/${contractNumber}`);
    log("MEASUREMENT", "Liberando alocação prévia da planilha (preventivo)...");
    await unlockPlanilha(page, { contractNumber, documentType }).catch((err) => {
        log("MEASUREMENT", `Aviso no desbloqueio preventivo: ${err.message}`);
    });

    // ── FASE 1: Navegar para listagem de medições ────────────────────────────
    log("MEASUREMENT", "Navegando para listagem de medições...");
    await page.goto(MEASUREMENTS_PAGE_URL, { waitUntil: "domcontentloaded" });
    await waitForPageSettled(page);
    await closeBlockingPopups(page);
    await page.waitForTimeout(1200); // aguarda modais que carregam após networkidle
    await closeBlockingPopups(page); // segunda passagem

    // ── FASE 2: Clicar em "Nova Medição" ─────────────────────────────────────
    // ATENÇÃO: NÃO usar safeClick aqui — ele chama waitUiStability após o clique,
    // que fecha o próprio modal de criação achando que é um popup bloqueante.
    log("MEASUREMENT", "Clicando em Nova Medição...");
    {
        const novaBtn = page.locator('button:has-text("Nova Medição")');
        await novaBtn.waitFor({ state: "visible", timeout: 30000 });
        await novaBtn.scrollIntoViewIfNeeded().catch(() => {});

        // Tenta clicar com retry se MuiDialog interceptar — mas sem fechar popups APÓS o clique
        let clicked = false;
        for (let attempt = 0; attempt < 4 && !clicked; attempt++) {
            await closeBlockingPopups(page); // fecha qualquer bloqueante ANTES
            try {
                await novaBtn.click({ timeout: 5000 });
                clicked = true;
            } catch (err) {
                if (!isPointerInterceptError(err)) throw err;
                log("MEASUREMENT", `Tentativa ${attempt + 1}: bloqueio detectado, fechando popup e retentando...`);
                await page.waitForTimeout(600);
            }
        }
        if (!clicked) throw new Error("Não foi possível clicar em 'Nova Medição' após 4 tentativas.");
    }

    const modalDialog = page.locator('[role="dialog"]');
    await modalDialog.waitFor({ state: "visible", timeout: 15000 });

    // ── FASE 3: Preencher modal ───────────────────────────────────────────────
    // 3a. Contrato — busca por "PREM 1" (documentType + contractNumber) para não ambiguidade
    log("MEASUREMENT", `Preenchendo Contrato: ${documentType}/${contractNumber}`);
    const contratoSearch = `${documentType}/${contractNumber}`;
    const contratoPattern = new RegExp(`${documentType}.*${contractNumber}`, "i");
    await fillAutocomplete(page, "contrato", contratoSearch, contratoPattern, modalDialog, { strict: true });

    // 3b. Obra — escopa ao modalDialog também
    log("MEASUREMENT", `Preenchendo Obra: ${obraCod}`);
    await fillAutocomplete(page, "codigoObra", String(obraCod), null, modalDialog);

    // 3c. Data de vencimento
    if (dataVencimento) {
        log("MEASUREMENT", `Preenchendo Data de vencimento: ${dataVencimento}`);
        const dataVencInput = page.locator('input[name="dataVencimento"]');
        await dataVencInput.waitFor({ state: "visible", timeout: 10000 });
        await dataVencInput.click();
        await dataVencInput.fill("");
        await dataVencInput.fill(dataVencimento);
        await dataVencInput.press("Tab");
        await page.waitForTimeout(300);
    }

    // 3d. Salvar Medição
    log("MEASUREMENT", "Clicando em Salvar Medição...");
    const salvarMedicaoBtn = modalDialog.locator('button:has-text("Salvar Medição")');
    await salvarMedicaoBtn.waitFor({ state: "visible", timeout: 15000 });
    // Desabilitado = campo obrigatório vazio: o erro diz qual, em vez de
    // estourar 30 s de timeout no clique.
    await assertEnabledOrExplain(salvarMedicaoBtn, modalDialog, "Salvar Medição");

    // Registra handler para alert nativo que pode surgir após o redirect
    let dialogDismissed = false;
    const dialogHandlerModal = async (dialog) => {
        log("MEASUREMENT", `Alert pós-Salvar Medição (${dialog.type()}): "${dialog.message()}" — aceitando...`);
        await dialog.accept().catch(() => {});
        dialogDismissed = true;
    };
    page.on('dialog', dialogHandlerModal);

    try {
        await salvarMedicaoBtn.click();
        // Aguarda modal fechar e página navegar para a medição
        await modalDialog.waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
        await waitForPageSettled(page);
        await closeBlockingPopups(page);
        if (dialogDismissed) {
            await waitForPageSettled(page);
            await closeBlockingPopups(page);
        }
    } finally {
        page.off('dialog', dialogHandlerModal);
    }

    // ── FASE 3d': Tela NOVA de edição (padrão do Sienge desde set/2026) ───────
    // Se o Sienge levou para .../medicoes/editar/..., preenche por lá. A tela
    // antiga (abaixo) fica como caminho de reserva.
    await page.waitForURL(EDIT_URL_RE, { timeout: 20000 }).catch(() => {});
    if (EDIT_URL_RE.test(page.url())) {
        log("MEASUREMENT", `Medição salva; tela nova aberta (${page.url().split("#")[1]}).`);
        const r = await fillMeasurementNewUi(page, { value, itemRef, files });
        success("MEASUREMENT", `Medição ${documentType}/${contractNumber} #${r.measurementNumber ?? "?"} preenchida pela tela nova.`);
        return { measurementNumber: r.measurementNumber, attached: r.attached };
    }

    // ── FASE 3e: Desativar "Nova tela" se o Sienge abriu a nova UI ───────────
    // Após "Salvar Medição", o Sienge pode redirecionar para a nova UI (React/MUI)
    // que não possui o iframe legado. O switch "Nova tela" precisa ser desativado
    // AQUI, antes de qualquer tentativa de acessar o iframe.
    try {
        const novaTelaSwitchLabel = page.locator('label:has-text("Nova tela")');
        const switchVisible = await novaTelaSwitchLabel.isVisible({ timeout: 6000 }).catch(() => false);
        if (switchVisible) {
            const isChecked = await novaTelaSwitchLabel
                .locator('input[type="checkbox"]')
                .isChecked()
                .catch(() => false);
            if (isChecked) {
                log("MEASUREMENT", "Nova UI detectada — fechando snackbars e desativando switch 'Nova tela'...");

                // Fecha qualquer Snackbar visível que possa interceptar o clique
                const snackbarBtns = page.locator('button[data-testid="snackbar-button-close"]');
                const snackCount = await snackbarBtns.count().catch(() => 0);
                for (let i = 0; i < snackCount; i++) {
                    const btn = snackbarBtns.nth(i);
                    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
                        log("MEASUREMENT", `Fechando Snackbar ${i + 1}/${snackCount}...`);
                        await btn.click({ force: true, timeout: 1000 }).catch(() => {});
                        await page.waitForTimeout(400);
                    }
                }

                await novaTelaSwitchLabel.click({ force: true });
                await waitForPageSettled(page);
                await closeBlockingPopups(page);
                log("MEASUREMENT", "Switch 'Nova tela' desativado — prosseguindo no layout legado.");
            }
        }
    } catch (err) {
        log("MEASUREMENT", `Aviso ao desativar 'Nova tela': ${err.message}`);
    }

    // ── FASE 4: Acessar Itens da medição ─────────────────────────────────────
    log("MEASUREMENT", "Acessando Itens da medição...");
    let frame = await getMainFrame(page);

    const itensLink = frame.locator('a:has-text("Itens")').first();
    await itensLink.waitFor({ state: "visible", timeout: 30000 });
    await itensLink.click();
    await waitForPageSettled(page);
    frame = await getMainFrame(page);

    // ── FASE 5: Selecionar "Valores monetários" ───────────────────────────────
    log("MEASUREMENT", "Selecionando Valores monetários...");
    const tpVlSelect = frame.locator('select[name="tpVlMonetario"]');
    await tpVlSelect.waitFor({ state: "visible", timeout: 30000 });
    await tpVlSelect.selectOption("V");
    await waitUiStability(page);
    await page.waitForTimeout(1500); // aguarda recarga da grade

    // ── FASE 6: Localizar unidade COMERCIAL (cdUnidObraContrato = 1) ──────────
    log("MEASUREMENT", "Localizando unidade COMERCIAL (cdUnidObraContrato=1)...");
    await frame.waitForSelector('tr[id^="linhaListUnidObContrato_"]:not([id$="-1"])', {
        state: "attached",
        timeout: 30000,
    });

    const comercialRowId = await frame.evaluate(() => {
        const rows = document.querySelectorAll('tr[id^="linhaListUnidObContrato_"]:not([id$="-1"])');
        for (const row of rows) {
            const cdInput = row.querySelector('input[id*="unidObContratoPK.cdUnidObraContrato_"]');
            if (cdInput && cdInput.value === "1") return row.id;
        }
        // Fallback: primeira linha não-template
        return rows[0]?.id || null;
    });

    if (!comercialRowId) {
        throw new Error("Unidade construtiva COMERCIAL (cdUnidObraContrato=1) não encontrada na medição.");
    }
    log("MEASUREMENT", `Unidade encontrada: ${comercialRowId}`);

    // Clica no lápis da linha COMERCIAL
    const editImg = frame.locator(`tr#${comercialRowId} img.spwImagemEditarGrid`).first();
    await editImg.scrollIntoViewIfNeeded().catch(() => {});
    await editImg.click({ force: true });
    await waitForPageSettled(page);
    frame = await getMainFrame(page);

    // ── FASE 7: Preencher valor da medição ────────────────────────────────────
    log("MEASUREMENT", `Preenchendo valor da medição: ${value} | item alvo (editável #${targetRowIndex})`);
    await frame.waitForSelector('tr[id^="linhaRow_"]:not([id$="-1"])', {
        state: "attached",
        timeout: 30000,
    });

    // Obtém em uma única roundtrip: número da medição e o campo editável alvo.
    // targetRowIndex é 1-based e conta apenas linhas com qtMedida editável —
    // itens com saldo zero ficam readonly no grid e são ignorados na contagem.
    // Se targetRowIndex exceder o total de editáveis, usa o último encontrado (fallback).
    const rowInfo = await frame.evaluate((targetIdx) => {
        let measurementNumber = null;
        let inputId = null;
        let lastEditableId = null;
        let editableCount = 0;

        const rows = document.querySelectorAll('tr[id^="linhaRow_"]:not([id$="-1"])');
        for (const row of rows) {
            const idx = row.id.replace("linhaRow_", "");

            // Captura nuMedicao do primeiro hidden input disponível
            if (!measurementNumber) {
                const nuInput = row.querySelector(`input[id*="nuMedicao_${idx}"]`);
                if (nuInput && parseInt(nuInput.value) > 0) {
                    measurementNumber = parseInt(nuInput.value);
                }
            }

            // Conta apenas os qtMedida editáveis (não readonly, não disabled)
            const qtInput = row.querySelector(`input[id^="row[${idx}].qtMedida_"]`);
            if (qtInput && !qtInput.readOnly && !qtInput.disabled) {
                editableCount++;
                lastEditableId = qtInput.id;
                if (editableCount === targetIdx) {
                    inputId = qtInput.id;
                }
            }
        }

        // Fallback: se targetIdx > total de editáveis, usa o último encontrado
        if (!inputId && lastEditableId) {
            inputId = lastEditableId;
        }

        return { measurementNumber, inputId, editableCount };
    }, targetRowIndex);

    if (!rowInfo.inputId) {
        throw new Error("Campo de valor da medição (qtMedida) não encontrado ou todos readonly.");
    }

    log("MEASUREMENT", `Campo: ${rowInfo.inputId} | Nº medição: ${rowInfo.measurementNumber || "?"} | editáveis=${rowInfo.editableCount}`);

    // Preenche o campo — 2 casas decimais (formato $.2 do Sienge)
    await safeFillMoney2(page, frame, `input[id="${rowInfo.inputId}"]`, value);

    // ── FASE 8: Salvar ────────────────────────────────────────────────────────
    log("MEASUREMENT", "Salvando medição...");
    await safeClick(page, frame, 'input[id="btSalvar"]');
    await waitForPageSettled(page);
    await closeBlockingPopups(page);

    const measurementNumber = rowInfo.measurementNumber;
    success(
        "MEASUREMENT",
        `Medição criada com sucesso para ${documentType}/${contractNumber}. Nº: ${measurementNumber ?? "??"}`
    );
    return { measurementNumber };
}

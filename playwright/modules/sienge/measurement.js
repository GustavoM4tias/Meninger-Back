// playwright/modules/sienge/measurement.js
import { log, success } from "../../core/logger.js";
import { dismissCommonPopups } from "../../core/popups.js";
import { unlockPlanilha } from "./unlockPlanilha.js";

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
async function fillAutocomplete(page, fieldName, searchText, matchText, container = null) {
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
    await fillAutocomplete(page, "contrato", contratoSearch, contratoPattern, modalDialog);

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
    await salvarMedicaoBtn.click();

    // Aguarda modal fechar e página navegar para a medição
    await modalDialog.waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
    await waitForPageSettled(page);
    await closeBlockingPopups(page);

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

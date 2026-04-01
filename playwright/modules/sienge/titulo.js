// playwright/modules/sienge/titulo.js
// Cria a liberação de medição (título) no Sienge
// URL: https://menin.sienge.com.br/sienge/8/index.html#/common/page/1961

import { log, success } from "../../core/logger.js";
import { dismissCommonPopups } from "../../core/popups.js";

const TITULO_PAGE_URL =
    "https://menin.sienge.com.br/sienge/8/index.html#/common/page/1961";
const MAIN_IFRAME_SELECTOR = 'iframe[title="iFramePage"]';

// ── helpers ───────────────────────────────────────────────────────────────────

async function waitForPageSettled(page) {
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
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

async function waitVisible(frame, selector, timeout = 30000) {
    const loc = frame.locator(selector);
    await loc.waitFor({ state: "visible", timeout });
    return loc;
}

/** Preenche um campo de texto simples */
async function fillField(frame, selector, value) {
    const loc = await waitVisible(frame, selector);
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.click();
    await loc.fill("");
    await loc.fill(String(value ?? ""));
}

/** Preenche e pressiona Tab para disparar AJAX de validação */
async function fillFieldAndTab(frame, page, selector, value) {
    await fillField(frame, selector, value);
    await frame.locator(selector).press("Tab");
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);
}

/**
 * Calcula a data de vencimento efetiva:
 * - mínimo: hoje + 6 dias (Sienge precisa de tempo para processar)
 * - se boletoDueDate for além disso, usa boletoDueDate
 */
function calcVencimento(boletoDueDateISO) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const minDate = new Date(today);
    minDate.setDate(minDate.getDate() + 6);

    let dueDate = null;
    if (boletoDueDateISO) {
        const s = String(boletoDueDateISO).trim();
        if (s.match(/^\d{4}-\d{2}-\d{2}/)) {
            // ISO: "2026-04-10" ou "2026-04-10T..."
            const [y, m, d] = s.slice(0, 10).split("-");
            dueDate = new Date(Number(y), Number(m) - 1, Number(d));
        } else if (s.match(/^\d{2}\/\d{2}\/\d{4}/)) {
            // DD/MM/YYYY
            const [d, m, y] = s.split("/");
            dueDate = new Date(Number(y), Number(m) - 1, Number(d));
        }
    }

    const eff = (!dueDate || isNaN(dueDate) || dueDate < minDate) ? minDate : dueDate;
    return `${String(eff.getDate()).padStart(2, "0")}/${String(eff.getMonth() + 1).padStart(2, "0")}/${eff.getFullYear()}`;
}

/** Formata data ISO ou DD/MM/YYYY para DD/MM/YYYY */
function fmtDate(dateStr) {
    if (!dateStr) return "";
    const s = String(dateStr).trim();
    if (s.match(/^\d{4}-\d{2}-\d{2}/)) {
        const [y, m, d] = s.slice(0, 10).split("-");
        return `${d}/${m}/${y}`;
    }
    return s; // assume já DD/MM/YYYY
}

// ── main export ───────────────────────────────────────────────────────────────

/**
 * Cria a liberação de medição (título) no Sienge.
 *
 * @param {object} page
 * @param {object} params
 * @param {string}        params.documentType      - Tipo do contrato (ex: "PREM")
 * @param {string}        params.contractNumber    - Número do contrato (ex: "1")
 * @param {number}        params.measurementNumber - Número da medição a liberar
 * @param {string}        params.nfType            - Tipo do documento fiscal (ex: "NFS", "NFE")
 * @param {string}        params.nfNumber          - Número da NF
 * @param {string}        params.nfIssueDate       - Data de emissão (ISO ou DD/MM/YYYY)
 * @param {string}        params.boletoDueDate     - Data de vencimento do boleto (ISO)
 * @param {string}        params.departamento      - Código do departamento (ex: "24")
 * @param {string|number} params.unitPrice         - Valor de mão de obra
 * @returns {{ tituloNumber: number|null }}
 */
export async function createTitulo(page, params = {}) {
    const {
        documentType = "PREM",
        contractNumber = "",
        measurementNumber = 1,
        nfType = "NFS",
        nfNumber = "",
        nfIssueDate = "",
        boletoDueDate = "",
        departamento = "24",
        unitPrice = "",
    } = params;

    const contratoLabel = `${documentType}/${contractNumber}`;
    const dtVencimento = calcVencimento(boletoDueDate);
    const dtEmissao = fmtDate(nfIssueDate);

    log("TITULO", `Iniciando criação de título para ${contratoLabel} medição #${measurementNumber}`);
    log("TITULO", `nfType=${nfType} | nfNumber=${nfNumber} | dtEmissao=${dtEmissao} | dtVencimento=${dtVencimento} | depto=${departamento}`);

    // ── FASE 1: Navegar para a página de liberação de medições ───────────────
    log("TITULO", "Navegando para a página de liberação de medições...");
    await page.goto(TITULO_PAGE_URL, { waitUntil: "domcontentloaded" });
    await waitForPageSettled(page);
    await dismissCommonPopups(page, 3000).catch(() => {});

    let frame = await getMainFrame(page);

    // ── FASE 2: Preencher filtro de contrato e consultar ─────────────────────
    log("TITULO", `Preenchendo filtro de contrato: ${contratoLabel}`);
    await fillField(frame, "#labelContrato", contratoLabel);

    const btFiltrar = frame.locator('input[name="btFiltrar"]');
    await btFiltrar.waitFor({ state: "visible", timeout: 15000 });
    await btFiltrar.click();
    await waitForPageSettled(page);
    frame = await getMainFrame(page);

    // ── FASE 3: Localizar linha da medição e clicar no lápis ─────────────────
    log("TITULO", `Localizando medição #${measurementNumber} na tabela...`);
    await frame.waitForSelector('tr[id^="linhaRow_"]', { state: "attached", timeout: 30000 });

    const targetRowId = await frame.evaluate((nuMedicao) => {
        const rows = document.querySelectorAll('tr[id^="linhaRow_"]:not([id$="-1"])');
        for (const row of rows) {
            const numSpan = row.querySelector('span[tipo="NUMBER"]');
            if (numSpan && parseInt(numSpan.innerText.trim(), 10) === nuMedicao) {
                return row.id;
            }
        }
        // Fallback: primeira linha disponível
        return rows[0]?.id || null;
    }, Number(measurementNumber));

    if (!targetRowId) {
        throw new Error(`Medição #${measurementNumber} não encontrada na tabela de liberações do contrato ${contratoLabel}.`);
    }

    log("TITULO", `Linha encontrada: ${targetRowId} — clicando no lápis...`);
    const editImg = frame.locator(`tr#${targetRowId} img[name_="editar"]`).first();
    await editImg.scrollIntoViewIfNeeded().catch(() => {});
    await editImg.click({ force: true });
    await waitForPageSettled(page);
    frame = await getMainFrame(page);

    // ── FASE 4: Clicar em "Novo" ─────────────────────────────────────────────
    log("TITULO", "Clicando em Novo...");
    const btNovo = frame.locator("#botaoNovo");
    await btNovo.waitFor({ state: "visible", timeout: 30000 });
    await btNovo.click();
    await waitForPageSettled(page);
    frame = await getMainFrame(page);

    // ── FASE 5: Preencher formulário do título ────────────────────────────────

    // 5a. Tipo de documento (cdDocumento) — ex: "NFS"
    log("TITULO", `Preenchendo documento: ${nfType}`);
    await fillFieldAndTab(frame, page, "#cdDocumento", nfType);

    // 5b. Número do documento (nuDocumento)
    if (nfNumber) {
        log("TITULO", `Preenchendo número do documento: ${nfNumber}`);
        await fillField(frame, "#nuDocumento", nfNumber);
        await frame.locator("#nuDocumento").press("Tab");
        await page.waitForTimeout(300);
    }

    // 5c. Data de emissão
    if (dtEmissao) {
        log("TITULO", `Preenchendo data de emissão: ${dtEmissao}`);
        await fillFieldAndTab(frame, page, "#dtEmissao", dtEmissao);
    }

    // 5d. Data de vencimento (com regra mínimo hoje+6)
    log("TITULO", `Preenchendo data de vencimento: ${dtVencimento}`);
    await fillFieldAndTab(frame, page, "#dtPrimeiroVencto", dtVencimento);

    // 5e. Valor mão de obra — preenche apenas se estiver zerado
    if (unitPrice) {
        const vlLoc = frame.locator("#entity\\.vlMaodeObra");
        const currentRaw = await vlLoc.inputValue().catch(() => "0,00");
        const currentVal = parseFloat(String(currentRaw).replace(/\./g, "").replace(",", ".")) || 0;
        if (currentVal === 0) {
            const n = Number(String(unitPrice).replace(/\s/g, "").replace(",", "."));
            const formatted = n.toFixed(2).replace(".", ",");
            log("TITULO", `Preenchendo valor mão de obra: ${formatted}`);
            await fillField(frame, "#entity\\.vlMaodeObra", formatted);
            await vlLoc.press("Tab");
            await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
            await page.waitForTimeout(400);
        } else {
            log("TITULO", `Valor mão de obra já preenchido pelo Sienge: ${currentRaw}`);
        }
    }

    // 5f. Departamento — ex: "24" Comercial, "25" Stand, "16" Marketing
    log("TITULO", `Preenchendo departamento: ${departamento}`);
    await fillFieldAndTab(frame, page, 'input[type="text"][name="entity.liberacaoME.cdDepartamento"]', departamento);

    // ── FASE 6: Salvar ────────────────────────────────────────────────────────
    log("TITULO", "Clicando em Salvar...");
    const btSalvar = frame.locator("#btSalvar");
    await btSalvar.waitFor({ state: "visible", timeout: 15000 });
    await btSalvar.click();
    await waitForPageSettled(page);
    frame = await getMainFrame(page);

    // ── FASE 7: Capturar número do título ─────────────────────────────────────
    log("TITULO", "Capturando número do título...");
    let tituloNumber = null;
    try {
        const nuTituloLoc = frame.locator("#nuTitulo");
        await nuTituloLoc.waitFor({ state: "visible", timeout: 20000 });
        const raw = await nuTituloLoc.inputValue();
        const parsed = parseInt(String(raw).replace(/\D/g, ""), 10);
        if (parsed > 0) {
            tituloNumber = parsed;
        } else {
            throw new Error(`Número do título inválido após salvar: "${raw}"`);
        }
    } catch (err) {
        throw new Error(`Salvar falhou ou título não gerado: ${err.message}`);
    }

    log("TITULO", `Número do título capturado: ${tituloNumber}`);

    // ── FASE 8: Finalizar ─────────────────────────────────────────────────────
    log("TITULO", "Clicando em Finalizar...");
    const btFinalizar = frame.locator("#btFinalizar");
    await btFinalizar.waitFor({ state: "visible", timeout: 15000 });
    await btFinalizar.click();
    await waitForPageSettled(page);

    success("TITULO", `Título #${tituloNumber} criado com sucesso para ${contratoLabel} medição #${measurementNumber}`);
    return { tituloNumber };
}

// playwright/modules/sienge/unlockPlanilha.js
import { log, success } from "../../core/logger.js";

const ALLOC_PAGE_URL = "https://menin.sienge.com.br/sienge/8/index.html#/common/page/2430";
const MAIN_IFRAME_SELECTOR = 'iframe[title="iFramePage"]';

async function getMainFrame(page, timeout = 60000) {
    const deadline = Date.now() + timeout;
    let lastErr;
    while (Date.now() < deadline) {
        try {
            const h = await page.waitForSelector(MAIN_IFRAME_SELECTOR, {
                state: "attached",
                timeout: Math.min(deadline - Date.now(), 8000),
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
    throw new Error(`Iframe não encontrado após ${timeout}ms. Erro: ${lastErr?.message}`);
}

/**
 * Libera TODAS as alocações de planilha de um contrato na página 2430.
 *
 * Usa frame.evaluate() para localizar as linhas em um único roundtrip ao browser
 * (evita iterar linha a linha via Playwright, que é ~100x mais lento).
 *
 * @param {import('playwright').Page} page
 * @param {{ contractNumber: string, documentType?: string }} opts
 */
export async function unlockPlanilha(page, { contractNumber, documentType } = {}) {
    log("UNLOCK", `Liberando alocação — ${documentType ?? "?"}/${contractNumber}`);

    const unlockPage = await page.context().newPage();
    unlockPage.on("dialog", async (d) => {
        log("UNLOCK", `Dialog: ${d.message()}`);
        await d.accept().catch(() => {});
    });

    try {
        await unlockPage.goto(ALLOC_PAGE_URL, { waitUntil: "domcontentloaded" });
        await unlockPage.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});

        const frame = await getMainFrame(unlockPage);

        // Aguarda DOM das linhas de dados
        await frame.waitForSelector(
            'tr[id^="linhaRow_"]:not([id$="-1"])',
            { state: "attached", timeout: 30000 }
        );
        await unlockPage.waitForTimeout(400);

        const nuContrato = String(contractNumber).trim();
        const cdDocumento = documentType ? String(documentType).trim() : null;

        // ── Busca todos os IDs das linhas que batem com o contrato ──────────
        // Roda inteiramente no contexto do iframe → 1 roundtrip, sem loop JS↔browser
        const matchingIds = await frame.evaluate(
            ({ nuContrato, cdDocumento }) => {
                const rows = document.querySelectorAll('tr[id^="linhaRow_"]');
                const found = [];
                for (const row of rows) {
                    if (row.id.endsWith("-1")) continue; // template oculto
                    const docInput = row.querySelector('input[id*="unidObContratoPK.cdDocumento_"]');
                    const numInput = row.querySelector('input[id*="unidObContratoPK.nuContrato_"]');
                    if (!docInput || !numInput) continue;
                    const numOk = numInput.value === nuContrato;
                    const docOk = !cdDocumento || docInput.value === cdDocumento;
                    if (numOk && docOk) found.push(row.id);
                }
                return found;
            },
            { nuContrato, cdDocumento }
        );

        log("UNLOCK", `Alocações encontradas: ${matchingIds.length} — ${matchingIds.join(", ") || "nenhuma"}`);

        if (matchingIds.length === 0) {
            log("UNLOCK", `Nenhuma alocação ativa para ${cdDocumento ?? "?"}/${nuContrato} — prosseguindo.`);
            return;
        }

        // ── Clica na lixeira de cada linha encontrada ────────────────────────
        // Nota: IDs têm formato "linhaRow_N" — sem caracteres especiais, sem CSS.escape
        for (const rowId of matchingIds) {
            const trash = frame
                .locator(`tr#${rowId} img.spwImagemExcluirGrid`)
                .first();
            await trash.waitFor({ state: "attached", timeout: 10000 });
            await trash.scrollIntoViewIfNeeded().catch(() => {});
            await trash.click({ force: true });
            // Aguarda a página lenta processar o clique antes de continuar
            await unlockPage.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
            await unlockPage.waitForTimeout(1500);
            log("UNLOCK", `Linha ${rowId} marcada para exclusão.`);
        }

        // ── Salva ────────────────────────────────────────────────────────────
        const saveBtn = frame.locator('input[name="pbSalvar"][value="Salvar"]');
        await saveBtn.waitFor({ state: "attached", timeout: 15000 });
        await saveBtn.click({ force: true });

        // Aguarda o servidor confirmar o save (página é lenta)
        await unlockPage.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
        await unlockPage.waitForTimeout(3000);

        success("UNLOCK", `${matchingIds.length} alocação(ões) liberada(s) para ${cdDocumento}/${nuContrato}.`);
    } finally {
        await unlockPage.close().catch(() => {});
    }
}

// playwright/core/browser.js
import { chromium } from "playwright";

// PLAYWRIGHT_HEADLESS=true  → headless (sem janela) — ideal para produção
// PLAYWRIGHT_HEADLESS=false → mostra o browser — útil para debug local
const HEADLESS = process.env.PLAYWRIGHT_HEADLESS !== 'false';

export async function createPage() {
    // Cada chamada cria um browser/contexto novo → sessão limpa
    const browser = await chromium.launch({
        headless: HEADLESS,
        slowMo: HEADLESS ? 0 : 50,
    });

    const context = await browser.newContext(); // perfil novo
    const page = await context.newPage();

    return { browser, context, page };
}

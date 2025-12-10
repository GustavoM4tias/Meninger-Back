// playwright/core/browser.js
import { chromium } from "playwright";

export async function createPage() {
    // Cada chamada cria um browser/contexto novo → sessão limpa
    const browser = await chromium.launch({
        headless: false,
        slowMo: 50
    });

    const context = await browser.newContext(); // perfil novo
    const page = await context.newPage();

    return { browser, context, page };
}

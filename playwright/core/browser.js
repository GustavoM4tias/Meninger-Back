// playwright/core/browser.js
import { chromium } from "playwright";

// PLAYWRIGHT_HEADLESS=true  → headless (sem janela) — ideal para produção
// PLAYWRIGHT_HEADLESS=false → mostra o browser — útil para debug local
const HEADLESS = process.env.PLAYWRIGHT_HEADLESS !== 'false';

// Em servidores Linux (produção/staging) o Chromium exige flags adicionais para
// rodar em ambiente headless sem sandbox de usuário. Sem elas a página não carrega.
const SERVER_ARGS = [
    '--no-sandbox',               // obrigatório ao rodar como root ou em containers
    '--disable-setuid-sandbox',   // complemento do no-sandbox
    '--disable-dev-shm-usage',    // evita crash por /dev/shm limitado (Docker/VPS)
    '--disable-gpu',              // GPU não disponível em servidores sem display
    '--disable-extensions',
];

export async function createPage() {
    // Cada chamada cria um browser/contexto novo → sessão limpa
    const browser = await chromium.launch({
        headless: HEADLESS,
        slowMo: HEADLESS ? 0 : 50,
        args: SERVER_ARGS,
    });

    const context = await browser.newContext(); // perfil novo
    const page = await context.newPage();

    return { browser, context, page };
}

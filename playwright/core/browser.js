// playwright/core/browser.js
import { chromium } from "playwright";

// PLAYWRIGHT_HEADLESS=true  → headless (sem janela) — padrão em produção
// PLAYWRIGHT_HEADLESS=false → mostra o browser — útil para debug local
const HEADLESS = process.env.PLAYWRIGHT_HEADLESS !== 'false';

/**
 * Cria uma página Playwright com configuração anti-detecção.
 *
 * Sites bancários (ex: ECO Cobrança Caixa) detectam headless via:
 *   - navigator.webdriver = true
 *   - User-Agent com "HeadlessChrome"
 *   - Ausência de plugins/canvas realistas
 *   - Flags de automação no Chromium
 *
 * As configurações abaixo fazem o browser headless parecer um usuário real,
 * funcionando em qualquer servidor sem necessidade de proxy.
 */
export async function createPage() {
    const browser = await chromium.launch({
        headless: HEADLESS,
        slowMo: HEADLESS ? 0 : 50,
        args: [
            // ── Obrigatório em servidores Linux ──────────────────────────────
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            // ── Anti-detecção de automação ────────────────────────────────────
            '--disable-blink-features=AutomationControlled', // remove navigator.webdriver
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-extensions',
            '--no-first-run',
            '--no-default-browser-check',
            '--window-size=1280,800',
            // ── Simula browser com aceleração de hardware ─────────────────────
            '--disable-accelerated-2d-canvas',
            '--num-raster-threads=4',
        ],
        ignoreDefaultArgs: ['--enable-automation'], // remove flag de automação padrão
    });

    const context = await browser.newContext({
        // Simula Chrome 124 no Windows 10 — idêntico ao de um usuário real
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
        // Simula navegador com hardware gráfico
        colorScheme: 'light',
    });

    // ── Remove todas as marcas de automação antes de qualquer script da página ──
    await context.addInitScript(() => {
        // Remove navigator.webdriver
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

        // Finge ter plugins instalados (Chrome real tem vários)
        Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5], // length > 0 indica browser real
        });

        // Finge ter linguagens configuradas
        Object.defineProperty(navigator, 'languages', {
            get: () => ['pt-BR', 'pt', 'en-US', 'en'],
        });

        // Remove rastros do Chrome headless no objeto window.chrome
        if (!window.chrome) {
            window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
        }

        // Corrige Notification.permission (headless retorna valor incomum)
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) =>
            parameters.name === 'notifications'
                ? Promise.resolve({ state: Notification.permission })
                : originalQuery(parameters);
    });

    const page = await context.newPage();
    return { browser, context, page };
}

// playwright/modules/ecocobranca/selectCompany.js
import { log, success } from '../../core/logger.js';

/**
 * Seleciona a empresa pelo CNPJ e navega direto ao formulário de Inclusão de Títulos.
 *
 * Fluxo:
 *   1. Seleciona radio da empresa + chama formSubmit() para registrar a empresa na sessão
 *   2. Chama enviaLink('InclusaoTituloServlet','6') para ir direto ao formulário de boleto
 *
 * @param {import('playwright').Page} page
 * @param {string} cnpj - CNPJ da empresa (formato livre, apenas dígitos)
 * @returns {Promise<import('playwright').Page>}
 */
export async function selectCompany(page, cnpj) {
    const cnpjDigits = cnpj.replace(/\D/g, '');
    const cnpjPadded = cnpjDigits.padStart(15, '0');

    log('ECO_SELECT', `Buscando empresa com CNPJ ${cnpjPadded}...`);

    // ── 1. Localiza e seleciona o radio da empresa ────────────────────────────
    const radioValue = await page.evaluate((targetCnpj) => {
        const rows = document.querySelectorAll('tr');
        for (const row of rows) {
            const cnpjInput = row.querySelector('input[name^="cnpj"]');
            if (cnpjInput && cnpjInput.value === targetCnpj) {
                const radio = row.querySelector('input[name="radioEmpresa"]');
                if (radio) return radio.value;
            }
        }
        return null;
    }, cnpjPadded);

    if (radioValue === null) {
        throw new Error(`Empresa com CNPJ ${cnpjPadded} não encontrada na lista do ECO Cobrança.`);
    }

    log('ECO_SELECT', `Empresa encontrada — radio value: ${radioValue}`);
    await page.click(`input[name="radioEmpresa"][value="${radioValue}"]`);

    // ── 2. Registra a empresa na sessão via formSubmit() ──────────────────────
    log('ECO_SELECT', 'Registrando empresa na sessão (formSubmit)...');
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
        page.evaluate(() => formSubmit()),
    ]);

    log('ECO_SELECT', `Sessão registrada. URL atual: ${page.url()}`);

    // ── 3. Navega direto ao formulário de Inclusão de Títulos ─────────────────
    log('ECO_SELECT', 'Abrindo formulário de Inclusão de Títulos...');
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
        page.evaluate(() => enviaLink('InclusaoTituloServlet', '6')),
    ]);

    log('ECO_SELECT', `URL após enviaLink: ${page.url()}`);

    // ── 4. Se caiu em tipo_inclusao, clica em doSubmit() para avançar ─────────
    if (page.url().includes('tipo_inclusao')) {
        log('ECO_SELECT', 'Página tipo_inclusao — executando doSubmit()...');
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
            page.evaluate(() => doSubmit()),
        ]);
        log('ECO_SELECT', `URL após doSubmit: ${page.url()}`);
    }

    // ── 5. Aguarda o campo seuNumero do formulário ────────────────────────────
    try {
        await page.waitForSelector('input[name="seuNumero"]', { timeout: 15000 });
    } catch {
        const urlFinal = page.url();
        const bodySnippet = await page.textContent('body').catch(() => '(não obtido)');
        throw new Error(
            `Formulário de título não encontrado após doSubmit.\n` +
            `URL final: ${urlFinal}\n` +
            `Body (300 chars): ${bodySnippet.slice(0, 300)}`
        );
    }

    success('ECO_SELECT', `Formulário de boleto disponível em: ${page.url()}`);
    return page;
}

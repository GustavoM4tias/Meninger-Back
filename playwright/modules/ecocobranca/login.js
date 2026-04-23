// playwright/modules/ecocobranca/login.js
import { createPage } from '../../core/browser.js';
import { log, success, error } from '../../core/logger.js';

const ECO_URL = 'https://ecobranca.caixa.gov.br/ecobranca/index.jsp';

/**
 * Realiza login no Ecobrança Caixa e retorna { browser, context, page }
 * já posicionado na página de seleção de empresa.
 *
 * @param {{ usuario: string, senha: string }} credentials
 */
export async function ecoLogin(credentials = {}) {
    const { usuario, senha } = credentials;
    if (!usuario || !senha) throw new Error('Credenciais Ecobrança não configuradas.');

    log('ECO_LOGIN', 'Abrindo navegador e acessando Ecobrança...');
    const { browser, context, page } = await createPage();

    page.on('dialog', async (dialog) => {
        try { await dialog.accept(); } catch (_) {}
    });

    await page.goto(ECO_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

    log('ECO_LOGIN', 'Preenchendo credenciais...');
    await page.fill('input[name="usuario"]', String(usuario));
    await page.fill('input[name="senha"]', String(senha));

    log('ECO_LOGIN', 'Confirmando login...');
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
        page.click('a[href="javascript:validaDados();"]'),
    ]).catch(() => {});

    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

    // Verifica se o login foi bem-sucedido checando por elemento da lista de empresas
    const hasCompanyList = await page.$('input[name="radioEmpresa"]').then(el => !!el).catch(() => false);
    if (!hasCompanyList) {
        const bodyText = await page.textContent('body').catch(() => '');
        if (bodyText.toLowerCase().includes('senha') || bodyText.toLowerCase().includes('inválid')) {
            throw new Error('Credenciais Ecobrança inválidas. Verifique usuário e senha nas configurações.');
        }
        throw new Error('Login Ecobrança falhou — página inesperada após autenticação.');
    }

    success('ECO_LOGIN', 'Login realizado com sucesso.');
    return { browser, context, page };
}

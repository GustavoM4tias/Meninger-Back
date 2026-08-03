// playwright/modules/ecocobranca/login.js
import { createPage } from '../../core/browser.js';
import { log, success, error } from '../../core/logger.js';

const ECO_URL = 'https://ecobranca.caixa.gov.br/ecobranca/index.jsp';
const SAIR_URL = 'https://ecobranca.caixa.gov.br/ecobranca/sair';

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

    // Qualquer exception daqui pra frente deve fechar o browser antes de
    // propagar — caso contrário a janela fica órfã (em produção, vira
    // processo Chromium zumbi consumindo memória; em dev local, janela
    // aberta na tela).
    try {
        page.on('dialog', async (dialog) => {
            try { await dialog.accept(); } catch (_) {}
        });

        // Encerra qualquer sessão anterior ANTES de logar. O Ecobrança mantém a
        // sessão no servidor e, se a execução anterior parou no meio de um
        // fluxo (uma baixa interrompida, por exemplo), o login seguinte é
        // REDIRECIONADO de volta pra lá em vez de mostrar a escolha de empresa.
        // Quando isso acontecia, a verificação de login até passava — a lista
        // aparecia por um instante — e o redirect vinha logo depois, então o
        // erro estourava adiante, no selectCompany, apontando para a URL do
        // fluxo antigo (ex.: baixa_titulo_escolha) e culpando o cadastro da
        // empresa. Sair primeiro custa uma requisição e elimina a categoria.
        await page.goto(SAIR_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

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
            throw new Error(
                `Login Ecobrança falhou — página inesperada após autenticação (URL: ${page.url()}).`,
            );
        }

        // Reconfirma depois de a página assentar: o portal às vezes redireciona
        // LOGO APÓS a checagem acima, e quem descobria isso era o selectCompany,
        // já fora do login, reportando "empresa não encontrada". Só devolvemos a
        // sessão quando a lista de empresas sobrevive a esse respiro.
        await page.waitForTimeout(700);
        const listaEstavel = await page.$('input[name="radioEmpresa"]').then(el => !!el).catch(() => false);
        if (!listaEstavel) {
            throw new Error(
                `Login Ecobrança instável — a tela de escolha de empresa foi substituída por ${page.url()} logo após o login. `
                + 'Normalmente é sessão anterior sendo restaurada; tente novamente.',
            );
        }

        success('ECO_LOGIN', 'Login realizado com sucesso.');
        return { browser, context, page };

    } catch (err) {
        // Fecha o browser antes de propagar pra evitar processos órfãos.
        // `.catch(() => {})` no close porque se o close em si falhar,
        // queremos preservar o erro original do login.
        error('ECO_LOGIN', `Falha — fechando browser. Motivo: ${err.message}`);
        await browser.close().catch(() => {});
        throw err;
    }
}

/**
 * Encerra a sessão no servidor do Ecobrança.
 *
 * OBRIGATÓRIO antes de fechar o browser. A sessão do portal é POR USUÁRIO, não
 * por cookie: fechar o navegador sem sair deixa o servidor parado no último
 * fluxo, e o PRÓXIMO login — de qualquer máquina, inclusive de outro ambiente —
 * é redirecionado pra lá em vez de abrir a escolha de empresa. Foi assim que a
 * emissão da reserva 8002 falhou sete vezes seguidas: cada falha fechava o
 * browser sem sair e envenenava a tentativa seguinte.
 *
 * Best-effort de propósito: se o logout falhar, o fluxo que já terminou não
 * deve quebrar por causa disso — o `sair` na entrada do próximo login cobre.
 */
export async function ecoLogout(page) {
    if (!page || page.isClosed?.()) return false;
    try {
        await page.goto(SAIR_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
        log('ECO_LOGIN', 'Sessão encerrada no portal.');
        return true;
    } catch (err) {
        log('ECO_LOGIN', `Logout best-effort falhou (${err.message}) — o próximo login sai antes de entrar.`);
        return false;
    }
}

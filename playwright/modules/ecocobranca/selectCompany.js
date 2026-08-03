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
/**
 * IMPORTANTE — UMA EMPRESA POR SESSÃO.
 *
 * A lista de empresas só existe em `acesso_escolha_empresa`, logo após o login.
 * Assim que uma empresa é escolhida, a sessão fica AMARRADA a ela: a lista some
 * e não há caminho de volta. Verificado no portal:
 *   - `novoAcesso()` (link "Novo Acesso") DESLOGA, indo para /ecobranca/index;
 *   - abrir /acesso_escolha_empresa direto devolve a página sem nenhuma empresa.
 *
 * Por isso trocar de empresa exige NOVO LOGIN. Quem processa várias empresas
 * (ex.: a verificação diária em lote) precisa abrir uma sessão por empresa —
 * reaproveitar a página fazia a 1ª empresa funcionar e todas as seguintes
 * falharem com "empresa não encontrada", mensagem que culpava o cadastro
 * quando o problema era a sessão.
 */
export async function selectCompany(page, cnpj) {
    const cnpjDigits = cnpj.replace(/\D/g, '');
    const cnpjPadded = cnpjDigits.padStart(15, '0');

    log('ECO_SELECT', `Buscando empresa com CNPJ ${cnpjPadded}...`);

    // ── 1. Localiza e seleciona o radio da empresa ────────────────────────────
    const { radioValue, total } = await page.evaluate((targetCnpj) => {
        const rows = document.querySelectorAll('tr');
        let encontrados = 0;
        let achado = null;
        for (const row of rows) {
            const cnpjInput = row.querySelector('input[name^="cnpj"]');
            const radio = row.querySelector('input[name="radioEmpresa"]');
            if (!cnpjInput || !radio) continue;
            encontrados++;
            if (achado === null && cnpjInput.value === targetCnpj) achado = radio.value;
        }
        return { radioValue: achado, total: encontrados };
    }, cnpjPadded);

    if (radioValue === null) {
        // A contagem separa "sessão sem a tela de escolha" de "empresa
        // realmente ausente do cadastro". Sem ela, os dois casos davam a mesma
        // mensagem e mandavam investigar o cadastro da empresa quando o
        // problema era a sessão já estar amarrada a outra.
        throw new Error(
            total === 0
                ? `Sessão do Ecobrança não está na tela de escolha de empresa (0 empresas em ${page.url()}). `
                  + 'A sessão já está amarrada a uma empresa: para usar outra é preciso fazer login de novo. '
                  + 'NÃO é problema de cadastro da empresa.'
                : `Empresa com CNPJ ${cnpjPadded} não encontrada entre as ${total} empresas do Ecobrança.`,
        );
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

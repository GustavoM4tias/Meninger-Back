// playwright/modules/sienge/login.js
import { createPage } from "../../core/browser.js";
import { log, success } from "../../core/logger.js";

/**
 * Realiza login no Sienge via Playwright.
 * @param {object} [credentials] - { email, password } — se não passado, usa env vars como fallback
 */
export async function siengeLogin(credentials = {}) {
    const email = credentials.email || process.env.SIENGE_USER;
    const password = credentials.password || process.env.SIENGE_PASS;

    if (!email || !password) {
        throw new Error('Credenciais Sienge não configuradas. Configure em Minha Conta → Credenciais Sienge.');
    }

    const { browser, context, page } = await createPage();

    log("LOGIN", "Acessando página inicial...");
    await page.goto("https://menin.sienge.com.br/sienge/");

    try {
        log("LOGIN", "Clicando em 'Entrar com Sienge ID'...");
        await page.getByRole("button", { name: "Entrar com Sienge ID" }).click({ timeout: 8000 });
        await page.waitForLoadState("domcontentloaded");
    } catch {
        log("LOGIN", "⚠ Botão 'Entrar com Sienge ID' não encontrado (talvez já redirecionou).");
    }

    // Tela "Bem-vindo" com conta salva
    const usarOutraConta = page.getByRole("button", { name: "Usar outra conta" });
    if (await usarOutraConta.count()) {
        log("LOGIN", "Tela 'Bem-vindo' encontrada. Clicando em 'Usar outra conta'...");
        await usarOutraConta.click();
        await page.waitForLoadState("domcontentloaded");
    }

    // E-mail — suporta Sienge ID v1 (legacy) e v2 (atual, 2026-05)
    // v2: campo e botão na mesma tela, senha aparece habilitada após "Continuar"
    const campoEmail = page
        .getByTestId("sign-in-v2-email-input").locator('input:not([disabled])')
        .or(page.getByRole("textbox", { name: "Seu e-mail" }))
        .first();

    if (await campoEmail.count()) {
        log("LOGIN", "Preenchendo e-mail...");
        await campoEmail.fill(email);

        log("LOGIN", "Clicando CONTINUAR...");
        const btnContinuar = page
            .getByTestId("sign-in-v2-submit-button")
            .or(page.getByTestId("signInForm").getByRole("button", { name: "CONTINUAR" }))
            .first();
        await btnContinuar.click();
    }

    // Senha — em v2 o campo já existe no DOM (era apenas oculto/desabilitado), então
    // aguardamos por um campo de senha realmente VISÍVEL e habilitado.
    log("LOGIN", "Aguardando campo de senha...");
    const campoSenha = page
        .getByTestId("sign-in-v2-password-input").locator('input:not([disabled])')
        .or(page.getByRole("textbox", { name: "Digite a sua senha" }))
        .first();
    await campoSenha.waitFor({ state: "visible", timeout: 15000 });

    log("LOGIN", "Preenchendo senha...");
    await campoSenha.fill(password);

    log("LOGIN", "Clicando ENTRAR...");
    // No v2 o botão tem o mesmo testid do "Continuar", agora com texto "Entrar"
    const btnEntrar = page
        .getByTestId("sign-in-v2-submit-button")
        .or(page.getByRole("button", { name: "ENTRAR" }))
        .first();
    await btnEntrar.click();

    // O login envolve uma cadeia de redirects (id.sienge.com.br → menin.sienge.com.br).
    // Usamos networkidle em vez de domcontentloaded para que a cadeia estabilize antes
    // de procurarmos a tela "usuário já está conectado".
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => null);

    // Tela "usuário já está conectado ao sistema" — aparece com frequência quando
    // há sessão Sienge ativa do mesmo usuário (caso comum na Menin). Pode reaparecer
    // em sequência se houver múltiplos avisos, por isso o loop.
    for (let i = 0; i < 3; i++) {
        const btnProsseguir = page.getByRole("link", { name: "Prosseguir" });
        const visivel = await btnProsseguir
            .waitFor({ state: "visible", timeout: 4000 })
            .then(() => true)
            .catch(() => false);

        if (!visivel) break;

        log("LOGIN", `Clicando em 'Prosseguir' (aviso ${i + 1})...`);
        await btnProsseguir.click();
        await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => null);
    }

    log("LOGIN", "Aguardando painel Sienge...");
    try {
        await page.waitForURL("**/sienge/**", { timeout: 45000 });
    } catch {
        // Timeout — verifica se é erro de credenciais na página
        const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        const lower = bodyText.toLowerCase();
        const isCredentialsError =
            lower.includes('senha incorreta') ||
            lower.includes('e-mail ou senha') ||
            lower.includes('invalid credentials') ||
            lower.includes('incorrect password') ||
            lower.includes('credenciais inválidas') ||
            lower.includes('acesso negado');
        if (isCredentialsError) {
            throw new Error('CREDENCIAIS_INVALIDAS: Senha ou e-mail incorretos no Sienge. Atualize em Minha Conta → Credenciais Sienge.');
        }
        throw new Error('Timeout ao aguardar login no Sienge. Verifique as credenciais e tente novamente.');
    }

    success("LOGIN", "Login realizado com sucesso!");
    return { browser, context, page };
}

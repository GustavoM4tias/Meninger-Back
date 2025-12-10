// playwright/modules/sienge/login.js
import { createPage } from "../../core/browser.js";
import { SIENGE_USER, SIENGE_PASS } from "../../config/env.js";
import { log, success } from "../../core/logger.js";

export async function siengeLogin() {
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

    // E-mail
    const campoEmail = page.getByRole("textbox", { name: "Seu e-mail" });
    if (await campoEmail.count()) {
        log("LOGIN", "Preenchendo e-mail...");
        await campoEmail.fill(SIENGE_USER);

        log("LOGIN", "Clicando CONTINUAR...");
        await page
            .getByTestId("signInForm")
            .getByRole("button", { name: "CONTINUAR" })
            .click();
    }

    // Senha
    log("LOGIN", "Aguardando campo de senha...");
    const campoSenha = page.getByRole("textbox", { name: "Digite a sua senha" });
    await campoSenha.waitFor({ timeout: 15000 });

    log("LOGIN", "Preenchendo senha...");
    await campoSenha.fill(SIENGE_PASS);

    log("LOGIN", "Clicando ENTRAR...");
    await page.getByRole("button", { name: "ENTRAR" }).click();
    await page.waitForLoadState("domcontentloaded");

    // Prosseguir
    const btnProsseguir = page.getByRole("link", { name: "Prosseguir" });
    if (await btnProsseguir.count()) {
        log("LOGIN", "Clicando em 'Prosseguir'...");
        await btnProsseguir.click();
        await page.waitForLoadState("domcontentloaded");
    }

    log("LOGIN", "Aguardando painel Sienge...");
    await page.waitForURL("**/sienge/**", { timeout: 45000 });

    success("LOGIN", "Login realizado com sucesso!");
    return { browser, context, page };
}

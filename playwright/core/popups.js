// playwright/core/popups.js
import { log } from "./logger.js";

export async function dismissCommonPopups(page, maxWaitMs = 4000) {
    log("POPUP", "Limpando popups rápidos...");

    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
        let fechouAlgo = false;

        // --------------------------
        // POPUP: Botão close-button (SEM CLICAR NO "+")
        // --------------------------
        try {
            const closeBtn = page.getByTestId("close-button");
            if (await closeBtn.count()) {
                log("POPUP", "Fechando popup via close-button...");
                await closeBtn.first().click({ force: true }).catch(() => { });
                fechouAlgo = true;
            }
        } catch { }

        // --------------------------
        // POPUP: Não mostrar novamente
        // --------------------------
        try {
            const naoMostrar = page.getByRole("checkbox", { name: /não mostrar novamente/i });
            if (await naoMostrar.count()) {
                log("POPUP", "Marcando 'Não mostrar novamente'...");
                await naoMostrar.check().catch(() => { });

                const fechar = page.getByRole("button", { name: /fechar/i });
                if (await fechar.count()) {
                    log("POPUP", "Clicando em 'Fechar'...");
                    await fechar.click().catch(() => { });
                }

                fechouAlgo = true;
            }
        } catch { }

        // --------------------------
        // POPUP: Não, obrigado
        // --------------------------
        try {
            const naoObrigado = page.getByRole("button", { name: /não, obrigado/i });
            if (await naoObrigado.count()) {
                log("POPUP", "Clicando em 'Não, obrigado'...");
                await naoObrigado.click().catch(() => { });
                fechouAlgo = true;
            }
        } catch { }

        if (!fechouAlgo) {
            await page.waitForTimeout(200);
        } else {
            await page.waitForTimeout(150);
        }
    }

    log("POPUP", "Todos os popups foram fechados.");
}

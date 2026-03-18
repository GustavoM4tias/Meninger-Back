import { log } from "./logger.js";

export async function dismissCommonPopups(page, maxWaitMs = 2000) {
    const start = Date.now();

    // Lista de seletores para busca paralela
    const popups = [
        { name: "Close Button", loc: page.getByTestId("close-button") },
        { name: "Não Mostrar", loc: page.getByRole("checkbox", { name: /não mostrar novamente/i }) },
        { name: "Não Obrigado", loc: page.getByRole("button", { name: /não, obrigado/i }) }
    ];

    while (Date.now() - start < maxWaitMs) {
        let algoDetectado = false;

        for (const popup of popups) {
            if (await popup.loc.count() > 0) {
                algoDetectado = true;
                try {
                    log("POPUP", `Limpando ${popup.name}...`);
                    if (popup.name === "Não Mostrar") {
                        await popup.loc.check({ timeout: 500 }).catch(() => null);
                        await page.getByRole("button", { name: /fechar/i }).click({ timeout: 500 }).catch(() => null);
                    } else {
                        await popup.loc.first().click({ force: true, timeout: 500 }).catch(() => null);
                    }
                } catch (e) { }
            }
        }

        // Se não detectou nada na passada, sai do loop imediatamente para ganhar tempo
        if (!algoDetectado) break;
        await page.waitForTimeout(100);
    }
}
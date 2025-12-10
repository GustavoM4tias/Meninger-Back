// playwright/services/contractService.js
import { siengeLogin } from "../modules/sienge/login.js";
import { createInitialContract } from "../modules/sienge/contract.js";
import { log, success } from "../core/logger.js";

export async function processInitialContract() {
    log("SERVICE", "Iniciando fluxo para criação de contrato...");

    const { browser, page } = await siengeLogin();

    log("SERVICE", "Indo preencher contrato inicial...");
    await createInitialContract(page);

    success("SERVICE", "Fluxo de contrato inicial finalizado.");
    // se quiser fechar no final:
    // await browser.close();
}

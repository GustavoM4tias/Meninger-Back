// playwright/index.js
import { processInitialContract } from "./services/contractService.js";

console.log("🚀 Iniciando automação Playwright...");

processInitialContract().catch((err) => {
    console.error("❌ ERRO GERAL NA AUTOMAÇÃO:", err);
});

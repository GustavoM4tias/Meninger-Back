// playwright/services/additiveService.js
import { siengeLogin } from "../modules/sienge/login.js";
import { createAdditive } from "../modules/sienge/additive.js";
import { comLoginNaFila } from "../core/filaSienge.js";
import { log, success } from "../core/logger.js";
import { dismissCommonPopups } from "../core/popups.js";

function registerGlobalDialogHandler(page) {
    page.on("dialog", async (dialog) => {
        try {
            const msg = dialog.message();
            log("DIALOG", `${dialog.type()}: ${msg}`);

            // Sinaliza para o fluxo que uma planilha está alocada para outro usuário
            if (msg.includes("planilha selecionada já está alocada")) {
                page._planilhaAlocadaDetected = true;
            }

            await dialog.accept();
        } catch (_) { }
    });
}

async function waitForPageReady(page) {
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => { });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => { });
}

/**
 * Modo automático — chamado pelo PaymentFlowPipelineService.
 * Recebe todos os parâmetros sem input do usuário.
 *
 * @param {object} params
 * @param {string} params.documentType        - Tipo do documento (ex: PCEF)
 * @param {string} params.contractNumber      - Número do contrato existente
 * @param {string} params.obraCod             - Código da obra (buildingId)
 * @param {string} params.descricao           - Descrição/objeto do aditivo
 * @param {string} params.dataAditivo         - dd/MM/yyyy (padrão: hoje)
 * @param {string} params.itemOrcamento       - Nome do item do orçamento
 * @param {string} params.itemOrcamentoCode   - Código do item do orçamento
 * @param {string} params.contaFinanceira     - Número da conta financeira
 * @param {string} params.percentualAlocacao  - Percentual (padrão: "100")
 * @param {string} params.precoMO             - Preço unitário mão de obra
 * @param {object} params.credentials         - { email, password } do Sienge
 */
export async function runPlaywrightAdditive(params = {}) {
    log("SERVICE", "Iniciando fluxo automático do aditivo...");
    log("SERVICE", `Parâmetros: ${JSON.stringify({
        documentType: params.documentType,
        contractNumber: params.contractNumber,
        obraCod: params.obraCod,
        itemOrcamentoCode: params.itemOrcamentoCode,
        contaFinanceira: params.contaFinanceira,
    })}`);

    // Na fila do login. Aditivo NÃO é refeito depois de uma derrubada: ele pode
    // ter sido salvo, e refazer duplicaria. Depois da espera, volta erro para conferir.
    return comLoginNaFila(params.credentials, `aditivo ${params.documentType}/${params.contractNumber}`, async (page, { retomando }) => {
        if (retomando) {
            throw new Error("Aditivo interrompido: o robô foi derrubado no meio do aditivo. Confira no Sienge se ele ficou salvo antes de reprocessar.");
        }
        await createAdditive(page, params);
        success("SERVICE", "Fluxo automático do aditivo concluído.");
        return { success: true };
    });
}

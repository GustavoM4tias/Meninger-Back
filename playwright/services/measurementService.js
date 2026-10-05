// playwright/services/measurementService.js
import { siengeLogin } from "../modules/sienge/login.js";
import { createMeasurement, openMeasurementEditor, fillMeasurementNewUi } from "../modules/sienge/measurement.js";
import { log, success } from "../core/logger.js";
import { dismissCommonPopups } from "../core/popups.js";
import { comLoginNaFila } from "../core/filaSienge.js";
import apiSienge from "../../lib/apiSienge.js";

/** Números das medições do contrato na obra (API, só leitura). */
async function numerosDasMedicoes({ documentType, contractNumber, obraCod }) {
    try {
        const { data } = await apiSienge.get("/v1/supply-contracts/measurements/all", {
            params: { documentId: documentType, contractNumber, limit: 200 },
        });
        return (data?.results || [])
            .filter(m => !obraCod || Number(m.buildingId) === Number(obraCod))
            .map(m => Number(m.measurementNumber));
    } catch (err) {
        if (err.response?.status === 404) return [];
        throw err;
    }
}

function registerGlobalDialogHandler(page) {
    page.on("dialog", async (dialog) => {
        try {
            log("DIALOG", `${dialog.type()}: ${dialog.message()}`);
            await dialog.accept();
        } catch (_) {}
    });
}

async function waitForPageReady(page) {
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
}

/**
 * Modo automático — chamado pelo PaymentFlowPipelineService.
 *
 * @param {object} params
 * @param {string} params.documentType      - Tipo do documento (ex: "CT")
 * @param {string} params.contractNumber    - Número do contrato existente
 * @param {string} params.obraCod           - Código da obra (erpId)
 * @param {string} params.dataVencimento    - DD/MM/YYYY (data de vencimento do boleto)
 * @param {string|number} params.value      - Valor da medição (unitPrice)
 * @param {number} [params.targetRowIndex]  - Índice 1-based do item editável a preencher (padrão: 1)
 * @param {object} params.credentials       - { email, password } do Sienge
 * @returns {{ success: true, measurementNumber: number|null }}
 */
export async function runPlaywrightMeasurement(params = {}) {
    log("SERVICE", "Iniciando fluxo automático da medição...");
    log("SERVICE", `Parâmetros: ${JSON.stringify({
        documentType: params.documentType,
        contractNumber: params.contractNumber,
        obraCod: params.obraCod,
        dataVencimento: params.dataVencimento,
        value: params.value,
        targetRowIndex: params.targetRowIndex ?? 1,
    })}`);

    // Na fila do login. Antes de criar, anota as medições que o contrato já tem:
    // derrubado depois de salvar, a retomada COMPLETA a medição nova (valor e
    // anexos) em vez de criar outra.
    const antes = new Set(await numerosDasMedicoes(params).catch(() => []));
    return comLoginNaFila(params.credentials, `medição ${params.documentType}/${params.contractNumber}`, async (page, { retomando }) => {
        if (retomando) {
            const novas = (await numerosDasMedicoes(params)).filter(n => !antes.has(n));
            if (novas.length) {
                const numero = Math.max(...novas);
                log("SERVICE", `Retomando: a medição ${numero} já foi criada antes da queda; completando sem criar outra.`);
                await openMeasurementEditor(page, { ...params, measurementNumber: numero });
                const r = await fillMeasurementNewUi(page, params);
                return { success: true, measurementNumber: numero, attached: r.attached || 0 };
            }
        }
        const result = await createMeasurement(page, params);
        success("SERVICE", `Fluxo automático da medição concluído. Nº: ${result.measurementNumber ?? "?"}`);
        return { success: true, measurementNumber: result.measurementNumber, attached: result.attached || 0 };
    });
}

/**
 * Completa uma medição que JÁ EXISTE (ex.: criada sem valor quando o robô caiu
 * no passo dos itens): abre a tela nova de edição, preenche o valor, salva e
 * anexa os PDFs. Não cria medição nova.
 *
 * @param {object} params - { documentType, contractNumber, obraCod, measurementNumber,
 *                            value, itemRef?, files?, credentials }
 */
export async function runPlaywrightCompleteMeasurement(params = {}) {
    log("SERVICE", `Completando medição ${params.documentType}/${params.contractNumber} #${params.measurementNumber}...`);
    return comLoginNaFila(params.credentials, `completar medição ${params.documentType}/${params.contractNumber} #${params.measurementNumber}`, async (page) => {
        await openMeasurementEditor(page, params);
        const r = await fillMeasurementNewUi(page, params);
        success("SERVICE", `Medição #${params.measurementNumber} completada.`);
        return { success: true, measurementNumber: params.measurementNumber, attached: r.attached };
    });
}

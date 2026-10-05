// playwright/services/paymentInfoService.js
import { setPaymentInfo, anexarNoTitulo, finalizarLiberacao } from "../modules/sienge/paymentInfo.js";
import { comLoginNaFila } from "../core/filaSienge.js";

/**
 * Num login só: forma de pagamento da parcela (boleto ou PIX) e/ou anexos do título.
 * @param {object} params - { credentials, titulo, parcela, origem, tipo?, linhaDigitavel, descricao, anexos? }
 *   tipo ausente = só anexa; anexos vazio = só forma de pagamento.
 *   finalizar = { documentType, contractNumber, measurementNumber }: finaliza a
 *   liberação da medição no fim (o Sienge só finaliza com o título completo).
 *
 * Tudo aqui é idempotente (regrava a forma, anexo pula o que já está, liberação
 * já finalizada é reconhecida): derrubado, a fila espera e refaz do começo.
 */
export async function runPlaywrightPaymentInfo(params = {}) {
    return comLoginNaFila(params.credentials, `pagamento/anexo do título ${params.titulo}`, async (page, { sessao }) => {
        const out = {};
        if (params.tipo) out.pagamento = await setPaymentInfo(page, params);
        // Anexo falhar não desfaz a forma de pagamento já salva: volta como aviso.
        if (params.anexos?.length) {
            try { out.anexos = await anexarNoTitulo(page, params); }
            catch (err) { if (await sessao.conferirTela()) throw err; out.anexoErro = err.message; }
        }
        if (params.finalizar?.measurementNumber && !out.anexoErro) {
            try { out.liberacao = await finalizarLiberacao(page, params.finalizar); }
            catch (err) { if (await sessao.conferirTela()) throw err; out.liberacaoErro = err.message; }
        }
        return out;
    });
}

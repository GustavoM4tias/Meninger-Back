// lib/atoStatus.js
//
// O status do ato agora vive na MENSAGEM da reserva, não na etapa do CV.
//
// Por quê: a etapa "Envio Sienge" é o gatilho do lote que manda a venda para o
// ERP, e era também o lugar de onde o Office tirava a reserva assim que o ato
// era emitido (Ato Emitido / Divergente / Pago / Vencido). Quando aquele lote
// falhava - e ele falha - a reserva já tinha saído da única etapa em que o
// lote a procura, e ninguém mais tentava: medimos 13% a 16% das reservas do
// ato sem contrato no Sienge entre junho e agosto de 2026, 28 delas com o ato
// já PAGO. Ficar parada em Envio Sienge não custa nada (141 reservas estão
// hoje nessa etapa já enviadas ao ERP, com 141 contratos distintos: o CV não
// reenvia quem tem `erp_sienge.enviado = 'S'`), e mantém a reserva ao alcance
// do próximo lote.
//
// Então a etapa deixa de ser o painel de status do ato. Quem informa passa a
// ser a mensagem postada na timeline da reserva, sempre com esta linha no topo.

/** Rótulos de status do ato - o mesmo vocabulário das etapas que substituíram. */
export const ATO_STATUS = {
    EMITIDO: 'ATO EMITIDO',
    DIVERGENTE: 'ATO DIVERGENTE',
    PAGO: 'ATO PAGO',
    BAIXADO: 'ATO BAIXADO',
};

/**
 * Primeira linha de toda mensagem do ato no CV.
 *
 * Vai no TOPO de propósito: na timeline da reserva o operador lê a primeira
 * linha de cada mensagem sem abrir, e é ali que ele procurava a etapa.
 *
 * SEM EMOJI de propósito: o `sanitizeCvMessage` do BoletoGenerationService
 * remove todo code point fora do BMP (e engole o espaço seguinte), então
 * 🏷️/📌 e afins sumiriam justamente na linha que mais importa. Caixa alta
 * resolve o destaque sem depender de símbolo.
 *
 * @param {string} status - um valor de ATO_STATUS
 * @returns {string} linha pronta (sem quebra no fim)
 */
export function linhaStatusAto(status) {
    return `STATUS DO ATO: ${status}`;
}

/**
 * Prefixa um corpo de mensagem com a linha de status.
 *
 * @param {string} status - um valor de ATO_STATUS
 * @param {string} corpo  - mensagem já montada
 */
export function comStatusAto(status, corpo) {
    return `${linhaStatusAto(status)}\n\n${corpo}`;
}

export default { ATO_STATUS, linhaStatusAto, comStatusAto };

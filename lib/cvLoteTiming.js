// lib/cvLoteTiming.js
//
// Timing pra mudança de situação CV após emissão de boleto.
//
// O CV roda lotes de "envio Sienge" nos múltiplos de 5 min (`:00, :05, :10`,
// ...). Se a etapa muda ANTES do lote rodar, o cliente nunca é enviado ao
// ERP. Após emissão agendamos a mudança pra um instante alinhado ao lote.
//
// Algoritmo (versão 2 — minimiza tempo de espera):
//   1. Calcula `next5` = próximo múltiplo de 5 minutos.
//   2. Se faltam menos de `safetyMin` minutos pro next5 (margem apertada
//      demais — risco de o CV não ter registrado a entrada antes do lote
//      processar), PULA pro seguinte (next5 + 5).
//   3. Adiciona +1 min de buffer pós-lote (garante que terminou).
//
// Exemplos com safetyMin = 2:
//   trigger :00 → next5 :05 (5min) ≥ 2 → +1 = :06 (delay 6 min)
//   trigger :01 → next5 :05 (4)    ≥ 2 → +1 = :06 (delay 5 min)
//   trigger :02 → next5 :05 (3)    ≥ 2 → +1 = :06 (delay 4 min)
//   trigger :03 → next5 :05 (2)    ≥ 2 → +1 = :06 (delay 3 min)
//   trigger :04 → next5 :05 (1)    <  2 → pula :10 → +1 = :11 (delay 7 min)
//   trigger :05 → next5 :10 (5)    ≥ 2 → +1 = :11 (delay 6 min)
//   trigger :09 → next5 :10 (1)    <  2 → pula :15 → +1 = :16 (delay 7 min)
//
// Garantia: delay efetivo entre 3 e 7 min (média ~5). Sempre alinhado 1 min
// após múltiplo de 5 (= momento que o lote acabou).

/**
 * Calcula o instante em que a situação CV deve ser aplicada.
 *
 * @param {Date}   [now]              - referência (default: agora)
 * @param {number} [safetyMin=2]      - margem mínima até o próximo lote pra
 *                                       não pular (em minutos)
 * @returns {Date}
 */
export function computeSituacaoTarget(now = new Date(), safetyMin = 2) {
    const target = new Date(now);
    const m = target.getMinutes();
    const next5 = m % 5 === 0 ? m + 5 : m + (5 - m % 5);
    target.setMinutes(next5);
    target.setSeconds(0, 0);
    target.setMilliseconds(0);

    // Se a janela até o próximo lote for menor que safetyMin, pula um ciclo.
    if ((target.getTime() - now.getTime()) < safetyMin * 60 * 1000) {
        target.setMinutes(target.getMinutes() + 5);
    }

    // +1 min de buffer pós-lote (garante que terminou)
    target.setMinutes(target.getMinutes() + 1);
    return target;
}

export default { computeSituacaoTarget };

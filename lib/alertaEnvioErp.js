// lib/alertaEnvioErp.js
//
// A REGRA DO TRIÂNGULO, em um lugar só: a reserva está em "Envio Sienge" há mais
// de N minutos e ainda não virou contrato no Sienge.
//
// Mora aqui porque dois lugares perguntam a mesma coisa - o relatório de
// reservas (a flag e o filtro) e o vigia que avisa. Se a regra fosse escrita
// duas vezes, um dia a tela e o aviso diriam coisas diferentes.
//
// ── O RELÓGIO ───────────────────────────────────────────────────────────────
// O lote do CV roda de 5 em 5 minutos. Medido em agosto/2026: os envios caem
// todos em minuto múltiplo de 5 (259 de 262) e, contando da ENTRADA na etapa,
// 226 de 238 vendas foram ao ERP em até 5 minutos, com mediana de 2. Passar de
// 30 minutos (seis rodadas) é erro, não demora.
//
// A entrada na etapa é o acionamento do webhook do ato (`boleto_history`), que o
// CV dispara quando a reserva entra em Envio Sienge - inclusive sem série de
// ato, quando o registro sai como `skipped`.
//
// NÃO use `erp_sienge.data_cad` como relógio: ele é a data de CRIAÇÃO da reserva
// (710 de 720 batem com `data_reserva`), então mede o ciclo da venda inteiro e
// faria o alerta tolerar erro por horas. Ele fica só como último recurso, para
// reserva que nunca acionou o webhook - e nesse caso o tempo sai maior que o
// real, por isso a tela marca como estimado.
import db from '../models/sequelize/index.js';

/** JOIN que traz o instante da entrada na etapa. Alias fixo: `ent`. */
export const ENTRADA_JOIN = `
          LEFT JOIN LATERAL (
            SELECT MAX(bh.created_at) AS entrou_em
              FROM boleto_history bh
             WHERE bh.idreserva = r.idreserva
          ) ent ON TRUE`;

/**
 * `erp_sienge.data_cad` só vira timestamp quando é uma data de verdade. O CV
 * grava "0000-00-00 00:00:00" em parte das reservas (7.138 linhas em
 * 02/09/2026, 6.439 delas sem webhook do ato), e esse valor não é uma data:
 * o cast direto derrubava a consulta inteira com "date/time field value out
 * of range" - o relatório de Reservas respondia 500 para qualquer período que
 * contivesse uma dessas reservas. Zero-data vira NULL, e NULL aqui significa
 * "sem relógio": a reserva não entra no alerta e a tela não mostra tempo.
 */
export const DATA_CAD_SQL = `(CASE
    WHEN r.erp_sienge->>'data_cad' ~ '^[12][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])'
    THEN (r.erp_sienge->>'data_cad')::timestamp AT TIME ZONE 'America/Sao_Paulo'
END)`;

/** Instante em que a reserva entrou em Envio Sienge (com o fallback). */
export const ENTRADA_SQL = `COALESCE(ent.entrou_em, ${DATA_CAD_SQL})`;

/** true quando o tempo veio do fallback - a tela avisa que é estimativa. */
export const ENTRADA_ESTIMADA_SQL = `(ent.entrou_em IS NULL)`;

/** Minutos parados em Envio Sienge. */
export const MINUTOS_PARADA_SQL = `round(EXTRACT(EPOCH FROM (NOW() - ${ENTRADA_SQL})) / 60)`;

/**
 * A condição do alerta. Usa os parâmetros `:alertaSituacao` e `:alertaMinutos`,
 * que devem entrar nos replacements (ver `getAlertaConfig`).
 */
export const ALERTA_ERP_SQL = `(
    r.situacao->>'idsituacao' = :alertaSituacao
    AND COALESCE(r.erp_sienge->>'enviado', 'N') <> 'S'
    AND ${ENTRADA_SQL} < NOW() - (:alertaMinutos * INTERVAL '1 minute')
)`;

/**
 * Limite e etapa vindos das settings do vigia - a tela manda, não o código.
 * @returns {Promise<{alertaSituacao: string, alertaMinutos: number}>}
 */
export async function getAlertaConfig() {
    let s = null;
    try {
        s = await db.EnvioSiengeWatchSettings.findByPk(1);
    } catch { /* módulo ainda não provisionado: cai nos padrões */ }
    return {
        alertaSituacao: String(s?.idsituacao_vigiada ?? 17),
        alertaMinutos: Number(s?.minutos_limite ?? 30),
    };
}

export default { ENTRADA_JOIN, DATA_CAD_SQL, ENTRADA_SQL, ENTRADA_ESTIMADA_SQL, MINUTOS_PARADA_SQL, ALERTA_ERP_SQL, getAlertaConfig };

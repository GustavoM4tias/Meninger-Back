// services/marketing/leadDaySql.js
//
// Expressão SQL do "dia do lead" em inbound_leads, compartilhada pelas telas
// que contam lead por período (relatório Meta e breakdown diário da campanha).
//
// Regra: vale a data de criação na Meta (raw_payload.graph.created_time) quando
// existe; senão, a captação local. Sem isso, lead trazido pelo import histórico
// cai no dia do import e desloca o CAC do mês inteiro. Convertido pro fuso de
// São Paulo (UTC-3 fixo) igual às demais telas de captação.

export const LEAD_DAY_SQL = `(
    (CASE WHEN raw_payload#>>'{graph,created_time}' ~ '^\\d{4}-\\d{2}-\\d{2}T'
          THEN (raw_payload#>>'{graph,created_time}')::timestamptz
          ELSE created_at END) AT TIME ZONE 'America/Sao_Paulo'
)::date`;

/** Mesma expressão como texto 'YYYY-MM-DD' (pra agrupar/serializar sem fuso). */
export const LEAD_DAY_TEXT_SQL = `to_char(${LEAD_DAY_SQL}, 'YYYY-MM-DD')`;

export default { LEAD_DAY_SQL, LEAD_DAY_TEXT_SQL };

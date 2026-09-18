// lib/ensureLeadsFusoCv.js
//
// Correção única das datas de `leads` gravadas no fuso errado (2026-09-18).
//
// O CV manda `data_cad` como texto de parede em horário de Brasília
// ("2026-09-18 10:30:00", sem fuso). O LeadSyncService gravava o texto direto
// e o Railway roda em UTC, então o banco entendia 10:30 UTC - três horas ANTES
// do instante real. Todo lead aparecia "há 4 horas" quando tinha 1 hora, e o
// join contrato → lead do Faturamento comparava esse valor com um created_at
// verdadeiro. Reservas e repasses tiveram o mesmo bug e ganharam o
// `parseCvDate` (lib/cvDate.js) em 27/08; a sync de leads nunca passou a usar.
//
// A partir de agora a sync grava o instante certo, e o delta reescreve os
// ativos + vendidos na primeira rodada. Os descartados (a maioria da tabela)
// nunca mais são relidos do CV, e sem esta passada ficariam três horas
// atrasados para sempre: o dia calculado com AT TIME ZONE 'America/Sao_Paulo'
// jogaria todo lead das 00h-03h no dia anterior nos relatórios históricos.
//
// `(col AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'` pega a parede
// que foi gravada e a reinterpreta como parede de Brasília - inclusive com o
// horário de verão de antes de 2019, que o Postgres conhece.
//
// Roda FORA do gate de schema (prod tem SKIP_DB_SYNC) e é idempotente: a
// atualização e a marca em `data_patches` vão na MESMA transação, então ou as
// duas existem ou nenhuma, e a segunda chamada só faz um SELECT.

import db from '../models/sequelize/index.js';

const PATCH = 'leads_fuso_cv_2026_09';
const COLUNAS = ['data_cad', 'data_reativacao', 'data_vencimento', 'ultima_data_conversao'];

export async function ensureLeadsFusoCv() {
    const { sequelize } = db;
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS data_patches (
            name       TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            detail     JSONB
        )`);

    const [[feito]] = await sequelize.query(
        `SELECT 1 FROM data_patches WHERE name = :name`, { replacements: { name: PATCH } });
    if (feito) return { applied: false };

    const sets = COLUNAS
        .map(c => `${c} = (${c} AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'`)
        .join(', ');

    return sequelize.transaction(async (transaction) => {
        const [, meta] = await sequelize.query(`UPDATE leads SET ${sets}`, { transaction });
        const rows = meta?.rowCount ?? null;
        await sequelize.query(
            `INSERT INTO data_patches (name, detail) VALUES (:name, :detail::jsonb)`,
            { replacements: { name: PATCH, detail: JSON.stringify({ rows, colunas: COLUNAS }) }, transaction });
        console.log(`🕒 [LeadsFusoCv] ${rows} leads deslocados de UTC para America/Sao_Paulo (uma vez).`);
        return { applied: true, rows };
    });
}

export default ensureLeadsFusoCv;

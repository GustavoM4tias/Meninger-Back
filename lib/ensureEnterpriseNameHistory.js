// lib/ensureEnterpriseNameHistory.js
//
// O NOME DO EMPREENDIMENTO É RÓTULO. O ID É A IDENTIDADE.
//
// O CV renomeia empreendimento: "Park Alameda" virou "Park Alameda - Sarandi".
// Todo lugar que filtrava por nome quebrou em silêncio nessa hora - a reserva
// antiga guarda o nome da época, a busca usa o nome de hoje, e metade do
// histórico some sem nenhum erro aparecer.
//
// `name_history` guarda os nomes anteriores para que a busca por qualquer um
// deles continue achando o mesmo empreendimento.
//
// A semente é o próprio passado: os nomes distintos que as RESERVAS guardam
// para cada empreendimento são, por definição, os nomes que ele já teve. Isso
// recupera o histórico que nunca foi registrado, sem depender de ninguém
// lembrar de nada.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `ALTER TABLE enterprises ADD COLUMN IF NOT EXISTS name_history JSONB NOT NULL DEFAULT '[]'::jsonb`,
];

export async function ensureEnterpriseNameHistory() {
    let applied = 0;
    let failed = 0;

    for (const sql of STATEMENTS) {
        try { await db.sequelize.query(sql); applied++; }
        catch (err) { failed++; console.warn(`⚠️  [SchemaPatch][EnterpriseNames] ${err.message}`); }
    }

    // ── Semente retroativa ───────────────────────────────────────────────────
    //
    // Roda a cada boot de propósito: um nome novo aparece quando o CV renomeia,
    // e este UPDATE é idempotente (só acrescenta o que falta). Não é `applyOnce`
    // porque não TROCA valor escolhido por ninguém - só completa uma lista.
    try {
        const [r] = await db.sequelize.query(`
            WITH nomes AS (
                SELECT
                    e.id,
                    ARRAY_AGG(DISTINCT trim(nome_na_reserva)) FILTER (
                        WHERE nome_na_reserva IS NOT NULL
                          AND trim(nome_na_reserva) <> ''
                          AND unaccent(upper(trim(nome_na_reserva))) <> unaccent(upper(trim(COALESCE(e.name, ''))))
                    ) AS anteriores
                FROM enterprises e
                JOIN reservas r
                  ON (
                       (NULLIF(r.unidade_json->>'idempreendimento_cv','')::int IS NOT NULL
                         AND e.cv_id = NULLIF(r.unidade_json->>'idempreendimento_cv','')::int)
                    OR (NULLIF(r.unidade_json->>'idempreendimento_int','')::int IS NOT NULL
                         AND e.cv_id = NULLIF(r.unidade_json->>'idempreendimento_int','')::int)
                  )
                CROSS JOIN LATERAL (
                    SELECT COALESCE(
                        NULLIF(trim(r.unidade_json->>'empreendimento'), ''),
                        NULLIF(trim(r.empreendimento), '')
                    ) AS nome_na_reserva
                ) n
                GROUP BY e.id
            )
            UPDATE enterprises e
               SET name_history = (
                   SELECT COALESCE(jsonb_agg(DISTINCT x), '[]'::jsonb)
                   FROM jsonb_array_elements_text(
                       e.name_history || to_jsonb(COALESCE(nomes.anteriores, ARRAY[]::text[]))
                   ) AS x
               )
              FROM nomes
             WHERE nomes.id = e.id
               AND COALESCE(array_length(nomes.anteriores, 1), 0) > 0
        `);
        applied++;
        console.log(`   ↳ histórico de nomes semeado a partir das reservas.`);
    } catch (err) {
        failed++;
        console.warn(`⚠️  [SchemaPatch][EnterpriseNames] semente: ${err.message}`);
    }

    console.log(`✅ [SchemaPatch] Histórico de nomes de empreendimento garantido (${applied} OK, ${failed} skip).`);
}

export default ensureEnterpriseNameHistory;

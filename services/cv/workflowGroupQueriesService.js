// services/cv/workflowGroupQueriesService.js
import db from '../../models/sequelize/index.js';

export async function getGroupProjections({ idgroup }) {
  const group = await db.CvWorkflowGroup.findByPk(idgroup);
  if (!group) throw new Error('Grupo não encontrado');

  const tipo = group.tipo; // 'reservas' | 'repasses'
  const situacoes = Array.isArray(group.situacoes_ids) ? group.situacoes_ids.filter(Number.isInteger) : [];
  const segmentos = Array.isArray(group.segmentos) ? group.segmentos.filter(s => typeof s === 'string' && s.trim().length) : [];

  if (!situacoes.length) {
    return { count: 0, results: [], meta: { tipo, segmentos, situacoes } };
  }

  const sql = `
    WITH
    base_reservas AS (
      ${tipo === 'repasses'
      ? `
            SELECT rr.*
            FROM repasses rp
            JOIN reservas rr ON rr.idreserva = rp.idreserva
            WHERE rp.idsituacao_repasse IN (:ids)
          `
      : `
            SELECT r.*
            FROM reservas r
            WHERE (r.situacao->>'idsituacao')::int IN (:ids)
          `
    }
    ),

    reservas_enriquecidas AS (
      SELECT
        b.*,
        (b.unidade_json->>'idempreendimento_int')::int  AS idemp_int,
        trim(both from (b.unidade_json->>'unidade'))     AS unidade_nome
      FROM base_reservas b
    ),

    reservas_segmentadas AS (
      SELECT re.*, ce.segmento_nome
      FROM reservas_enriquecidas re
      LEFT JOIN cv_enterprises ce
        ON ce.idempreendimento_int::int = re.idemp_int
      ${segmentos.length ? `WHERE ce.segmento_nome IN (:segments)` : ``}
    ),

    /* 4) Excluir SOMENTE se:
          - enterprise_id coincide
          - unidade (units.name) coincide
          - situation = 'Emitido'
          - financial_institution_date IS NOT NULL  <-- NOVO
    */
    reservas_filtradas AS (
      SELECT rs.*
      FROM reservas_segmentadas rs
      WHERE NOT EXISTS (
        SELECT 1
        FROM contracts c
        JOIN LATERAL (
          SELECT trim(both from u.name) AS unit_name
          FROM jsonb_to_recordset(c.units) AS u("id" int, "main" boolean, "name" text, "participationPercentage" numeric)
        ) cu ON true
        WHERE
          c.enterprise_id = rs.idemp_int
          AND c.situation = 'Emitido'
          AND cu.unit_name = rs.unidade_nome
          AND c.financial_institution_date IS NOT NULL   -- <=== requisito adicional
      )
    ),

    last_status AS (
      SELECT
        rf.idreserva,
        MAX(
          GREATEST(
            NULLIF((s->>'data_status_repasse'), '')::timestamptz,
            NULLIF((s->>'captured_at'), '')::timestamptz
          )
        ) AS last_status_at
      FROM reservas_filtradas rf
      LEFT JOIN LATERAL jsonb_array_elements(COALESCE(rf.status, '[]'::jsonb)) s ON true
      GROUP BY rf.idreserva
    )

    SELECT rf.*, ls.last_status_at
    FROM reservas_filtradas rf
    LEFT JOIN last_status ls USING (idreserva)
    ORDER BY
      ls.last_status_at DESC NULLS LAST,
      rf.data_reserva DESC NULLS LAST,
      rf.idreserva DESC
  `;

  const results = await db.sequelize.query(sql, {
    replacements: {
      ids: situacoes,
      segments: segmentos.length ? segmentos : undefined,
    },
    type: db.Sequelize.QueryTypes.SELECT,
  });

  return {
    count: results.length,
    results,
    meta: { tipo, segmentos, situacoes }
  };
}

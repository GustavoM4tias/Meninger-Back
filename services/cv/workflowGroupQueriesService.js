// services/cv/workflowGroupQueriesService.js
import db from '../../models/sequelize/index.js'

export async function getGroupProjections({ idgroup, isAdmin, userCity }) {
  const group = await db.CvWorkflowGroup.findByPk(idgroup)
  if (!group) throw new Error('Grupo não encontrado')

  const tipo = group.tipo // 'reservas' | 'repasses'
  const situacoes = Array.isArray(group.situacoes_ids)
    ? group.situacoes_ids.filter(Number.isInteger)
    : []

  const segmentos = Array.isArray(group.segmentos)
    ? group.segmentos.filter((s) => typeof s === 'string' && s.trim().length)
    : []

  if (!situacoes.length) {
    return {
      count: 0,
      results: [],
      meta: { tipo, segmentos, situacoes, city: isAdmin ? null : userCity }
    }
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

    /* ids que a reserva pode ter */
    NULLIF((b.unidade_json->>'idempreendimento_int'), '')::int AS idemp_int_from_reserva,
    NULLIF((b.unidade_json->>'idempreendimento_cv'), '')::int  AS idemp_cv_from_reserva,

    /* nomes */
    COALESCE(NULLIF(trim(both from (b.unidade_json->>'empreendimento')), ''), NULLIF(trim(both from b.empreendimento), '')) AS empreendimento_nome,
    trim(both from (b.unidade_json->>'unidade')) AS unidade_nome
  FROM base_reservas b
),

/*
  Resolve cidade (e também o ERP ID) SEM depender de idempreendimento_int na reserva,
  usando:
  1) match por erp_id (quando existe)
  2) match por crm_id (quando existe)
  3) match por enterprise_name (fallback)
*/
reservas_com_cidade AS (
  SELECT
    re.*,
    ec_city.city_resolved,
    ec_city.erp_id_int AS idemp_erp_resolvido
  FROM reservas_enriquecidas re

  LEFT JOIN LATERAL (
    SELECT
      COALESCE(ec.city_override, ec.default_city) AS city_resolved,
      NULLIF(ec.erp_id, '')::int                 AS erp_id_int
    FROM enterprise_cities ec
    WHERE
      (
        re.idemp_int_from_reserva IS NOT NULL
        AND ec.erp_id = re.idemp_int_from_reserva::text
      )
      OR (
        re.idemp_int_from_reserva IS NULL
        AND re.idemp_cv_from_reserva IS NOT NULL
        AND ec.crm_id = re.idemp_cv_from_reserva
      )
      OR (
        re.idemp_int_from_reserva IS NULL
        AND re.idemp_cv_from_reserva IS NULL
        AND re.empreendimento_nome IS NOT NULL
        AND re.empreendimento_nome <> ''
        AND unaccent(upper(regexp_replace(COALESCE(ec.enterprise_name,''), '[^A-Z0-9]+',' ','g'))) =
            unaccent(upper(regexp_replace(re.empreendimento_nome,        '[^A-Z0-9]+',' ','g')))
      )
    ORDER BY ec.updated_at DESC
    LIMIT 1
  ) ec_city ON TRUE
),

reservas_segmentadas AS (
  SELECT
    rcc.*,
    ce.segmento_nome
  FROM reservas_com_cidade rcc

  /* segmento usa o ERP id resolvido (ou o id da reserva se existir) */
  LEFT JOIN cv_enterprises ce
    ON ce.idempreendimento_int::int = COALESCE(rcc.idemp_int_from_reserva, rcc.idemp_erp_resolvido)

  WHERE 1=1
  ${segmentos.length ? `AND ce.segmento_nome IN (:segments)` : ``}
  ${isAdmin
      ? ``
      : `
        AND rcc.city_resolved IS NOT NULL
        AND unaccent(upper(regexp_replace(rcc.city_resolved, '[^A-Z0-9]+',' ','g'))) =
            unaccent(upper(regexp_replace(:userCity,      '[^A-Z0-9]+',' ','g')))
      `
    }
),

/*
  Excluir SOMENTE se:
    - enterprise_id (do contract) coincide com o ERP id resolvido do empreendimento da reserva
    - unidade coincide
    - situation = 'Emitido'
    - financial_institution_date IS NOT NULL
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
      c.enterprise_id = COALESCE(rs.idemp_int_from_reserva, rs.idemp_erp_resolvido)
      AND c.situation = 'Emitido'
      AND cu.unit_name = rs.unidade_nome
      AND c.financial_institution_date IS NOT NULL
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
  rf.idreserva DESC;
`

  const replacements = {
    ids: situacoes
  }

  if (segmentos.length) replacements.segments = segmentos
  if (!isAdmin) replacements.userCity = userCity

  const results = await db.sequelize.query(sql, {
    replacements,
    type: db.Sequelize.QueryTypes.SELECT
  })

  return {
    count: results.length,
    results,
    meta: { tipo, segmentos, situacoes, city: isAdmin ? null : userCity }
  }
}
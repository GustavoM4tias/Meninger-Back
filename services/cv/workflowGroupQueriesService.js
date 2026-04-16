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
    NULLIF((b.unidade_json->>'idbloco'), '')::int AS idbloco_cv_from_reserva,

    /* nomes */
    COALESCE(NULLIF(trim(both from (b.unidade_json->>'empreendimento')), ''), NULLIF(trim(both from b.empreendimento), '')) AS empreendimento_nome,
    trim(both from (b.unidade_json->>'unidade')) AS unidade_nome
  FROM base_reservas b
),

/*
  Resolve cidade (e também o ERP ID) tentando todas as estratégias em paralelo,
  com ordem de prioridade explícita:
  1) erp_id = idempreendimento_int  (CV interno == Sienge ERP — caso de integração direta)
  2) crm_id = idempreendimento_int  (CV interno == CRM ID da tabela enterprise_cities)
  3) crm_id = idempreendimento_cv   (campo CRM explícito da reserva)
  4) match por nome exato normalizado (fallback)

  Antes as condições 2-4 ficavam bloqueadas pelos IS NULL guards, impedindo
  que módulos/fases fossem resolvidos quando idempreendimento_int estava preenchido.
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
      NULLIF(ec.erp_id, '')::int                  AS erp_id_int
    FROM enterprise_cities ec
    /* Look up block ERP code for highest-priority matching */
    LEFT JOIN LATERAL (
      SELECT ceb.idbloco_int
      FROM cv_enterprise_blocks ceb
      WHERE ceb.idbloco = re.idbloco_cv_from_reserva
      LIMIT 1
    ) blk ON TRUE
    WHERE
      /* 0) Block's ERP code (most precise for fase/módulo) */
      (blk.idbloco_int IS NOT NULL AND ec.erp_id = regexp_replace(blk.idbloco_int, '[^0-9].*', ''))
      /* 1) idempreendimento_int é o próprio Sienge ERP ID */
      OR (re.idemp_int_from_reserva IS NOT NULL AND ec.erp_id = re.idemp_int_from_reserva::text)
      /* 2) idempreendimento_int é o CRM ID do CV */
      OR (re.idemp_int_from_reserva IS NOT NULL AND ec.crm_id = re.idemp_int_from_reserva)
      /* 3) campo idempreendimento_cv é o CRM ID do CV */
      OR (re.idemp_cv_from_reserva IS NOT NULL AND ec.crm_id = re.idemp_cv_from_reserva)
      /* 4) fallback por nome exato normalizado */
      OR (
        re.empreendimento_nome IS NOT NULL
        AND re.empreendimento_nome <> ''
        AND unaccent(upper(regexp_replace(COALESCE(ec.enterprise_name,''), '[^A-Z0-9]+',' ','g'))) =
            unaccent(upper(regexp_replace(re.empreendimento_nome,         '[^A-Z0-9]+',' ','g')))
      )
    ORDER BY
      CASE
        WHEN blk.idbloco_int IS NOT NULL AND ec.erp_id = regexp_replace(blk.idbloco_int, '[^0-9].*', '') THEN 1
        WHEN re.idemp_int_from_reserva IS NOT NULL AND ec.erp_id = re.idemp_int_from_reserva::text THEN 2
        WHEN re.idemp_int_from_reserva IS NOT NULL AND ec.crm_id = re.idemp_int_from_reserva       THEN 3
        WHEN re.idemp_cv_from_reserva  IS NOT NULL AND ec.crm_id = re.idemp_cv_from_reserva        THEN 4
        ELSE 5
      END,
      ec.updated_at DESC
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
  Pré-materializa os pares (enterprise_id, unit_name) dos contratos Emitidos
  apenas para os empreendimentos presentes nas projeções filtradas.
  Isso evita fazer a expansão JSONB por linha dentro do NOT EXISTS,
  reduzindo o custo de O(projeções × contratos × json) para uma única passagem.
*/
contracts_units_flat AS (
  SELECT DISTINCT
    c.enterprise_id,
    trim(both from u.name) AS unit_name
  FROM contracts c
  CROSS JOIN LATERAL jsonb_to_recordset(c.units) AS u(
    "id" int, "main" boolean, "name" text, "participationPercentage" numeric
  )
  WHERE c.situation = 'Emitido'
    AND c.financial_institution_date IS NOT NULL
    AND c.enterprise_id IN (
      SELECT COALESCE(rs2.idemp_erp_resolvido, rs2.idemp_int_from_reserva)
      FROM reservas_segmentadas rs2
      WHERE COALESCE(rs2.idemp_erp_resolvido, rs2.idemp_int_from_reserva) IS NOT NULL
    )
    AND trim(both from u.name) IS NOT NULL
    AND trim(both from u.name) <> ''
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
    FROM contracts_units_flat cu
    WHERE cu.enterprise_id = COALESCE(rs.idemp_erp_resolvido, rs.idemp_int_from_reserva)
      AND cu.unit_name = rs.unidade_nome
  )
),

/*
  Resolve company_id/company_name a partir dos contratos reais já faturados,
  usando o enterprise_id resolvido (ERP) ou o interno do CV como fallback.
  Isso permite que o frontend associe projeções à empresa correta.
*/
reservas_com_empresa AS (
  SELECT
    rf.*,
    comp.company_id  AS empresa_id,
    comp.company_name AS empresa_nome
  FROM reservas_filtradas rf
  LEFT JOIN LATERAL (
    SELECT c.company_id, c.company_name
    FROM contracts c
    WHERE c.company_id IS NOT NULL
      AND c.enterprise_id = COALESCE(rf.idemp_erp_resolvido, rf.idemp_int_from_reserva)
    LIMIT 1
  ) comp ON TRUE
),

last_status AS (
  SELECT
    rce.idreserva,
    MAX(
      GREATEST(
        NULLIF((s->>'data_status_repasse'), '')::timestamptz,
        NULLIF((s->>'captured_at'), '')::timestamptz
      )
    ) AS last_status_at
  FROM reservas_com_empresa rce
  LEFT JOIN LATERAL jsonb_array_elements(COALESCE(rce.status, '[]'::jsonb)) s ON true
  GROUP BY rce.idreserva
)

SELECT rce.*, ls.last_status_at
FROM reservas_com_empresa rce
LEFT JOIN last_status ls USING (idreserva)
ORDER BY
  ls.last_status_at DESC NULLS LAST,
  rce.data_reserva DESC NULLS LAST,
  rce.idreserva DESC;
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
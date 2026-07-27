// services/cv/workflowGroupQueriesService.js
import db from '../../models/sequelize/index.js'

export async function getGroupProjections({
  idgroup,
  isAdmin,
  userCity,
  companyIds = [],
  enterpriseIds = []
}) {
  const group = await db.CvWorkflowGroup.findByPk(idgroup)
  if (!group) throw new Error('Grupo não encontrado')

  const tipo = group.tipo // 'reservas' | 'repasses'
  const situacoes = Array.isArray(group.situacoes_ids)
    ? group.situacoes_ids.filter(Number.isInteger)
    : []

  // Corte por inatividade: reserva/repasse parada há mais que isso deixa de
  // contar como próxima entrada. Encalhado não é previsão de venda. 0/null
  // desliga o corte.
  const staleDaysRaw = Number(group.stale_days)
  const staleDays = Number.isFinite(staleDaysRaw) && staleDaysRaw > 0 ? Math.floor(staleDaysRaw) : 0
  const hasStaleCut = staleDays > 0

  const segmentos = Array.isArray(group.segmentos)
    ? group.segmentos.filter((s) => typeof s === 'string' && s.trim().length)
    : []

  // Sanitiza filtros opcionais
  const companyIdsSafe = Array.isArray(companyIds)
    ? [...new Set(companyIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))]
    : []
  const enterpriseIdsSafe = Array.isArray(enterpriseIds)
    ? [...new Set(enterpriseIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))]
    : []

  const hasCompanyIds = companyIdsSafe.length > 0
  const hasEnterpriseIds = enterpriseIdsSafe.length > 0

  if (!situacoes.length) {
    return {
      count: 0,
      results: [],
      meta: {
        tipo,
        segmentos,
        situacoes,
        city: isAdmin ? null : userCity,
        companyIds: companyIdsSafe,
        enterpriseIds: enterpriseIdsSafe
      }
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

    /*
      Código interno da ETAPA — é ele que carrega o centro de custo do Sienge.
      No CV, idempreendimento_int às vezes vem com o código da EMPRESA (ex.: 99
      em TERRAS DE SÃO PAULO V, 78 em PARQUE DOS IPÊS), que não é centro de
      custo nenhum. Já o idetapa_int é sempre o CC da fase (99905 = FASE 3).
      Como no Sienge cada fase é um empreendimento próprio, é este o código que
      identifica o destino corretamente.
    */
    NULLIF((b.unidade_json->>'idetapa_int'), '')::int AS idetapa_int_from_reserva,
    NULLIF((b.unidade_json->>'idetapa_cv'), '')::int  AS idetapa_cv_from_reserva,

    /* nomes */
    COALESCE(NULLIF(trim(both from (b.unidade_json->>'empreendimento')), ''), NULLIF(trim(both from b.empreendimento), '')) AS empreendimento_nome,
    /*
      Etapa (fase/módulo). No CV a hierarquia é empreendimento → etapa → bloco →
      unidade; no Sienge cada fase costuma ser um empreendimento (centro de
      custo) próprio. Quando isso acontece, o empreendimento do CV sozinho não
      identifica o destino no Sienge — só a etapa desempata.
    */
    COALESCE(NULLIF(trim(both from (b.unidade_json->>'etapa')), ''), NULLIF(trim(both from b.etapa), '')) AS etapa_nome,
    trim(both from (b.unidade_json->>'unidade')) AS unidade_nome
  FROM base_reservas b
),

/*
  Vínculo do CV para o Sienge — 100% POR CÓDIGO, sem comparar nome.

  A chave é o idetapa_int: no CV, cada ETAPA (fase/módulo) carrega o código do
  centro de custo do Sienge. O idempreendimento_int NÃO serve como chave: em
  vários empreendimentos ele vem com o código da EMPRESA (99 em TERRAS DE SÃO
  PAULO V, 78 em PARQUE DOS IPÊS, 89 em JARDIM MÔNACO, 107 em SANTA STELLA),
  que não é centro de custo nenhum. Como no Sienge cada fase é um
  empreendimento próprio, é a etapa que identifica o destino.

  Casar por nome foi abandonado: além de frágil, mandava valor para o centro de
  custo errado sem avisar (o MÓDULO 02 do RESIDENCIAL DOS ANJOS ia para o CC do
  MÓDULO 01).
*/
reservas_com_link AS (
  SELECT
    re.*,
    lnk.erp_enterprise_id AS idemp_erp_link,
    /* Fallback: quando a reserva não traz idetapa_int, busca no cadastro de
       etapas do CV pelo idetapa_cv. Mesma informação, outra origem. */
    st.idetapa_int_cadastro
  FROM reservas_enriquecidas re
  LEFT JOIN LATERAL (
    SELECT NULLIF(s.idetapa_int, '')::int AS idetapa_int_cadastro
    FROM cv_enterprise_stages s
    WHERE s.idetapa = re.idetapa_cv_from_reserva
    LIMIT 1
  ) st ON TRUE
  /*
    Vínculo MANUAL (enterprise_erp_links): override explícito para exceções.
    Casa por código — etapa do CV (preferido) ou empreendimento do CV.
  */
  LEFT JOIN LATERAL (
    SELECT l.erp_enterprise_id
    FROM enterprise_erp_links l
    WHERE l.active = true
      AND (
        (l.cv_stage_id IS NOT NULL AND l.cv_stage_id = re.idetapa_cv_from_reserva)
        OR (
          l.cv_stage_id IS NULL
          AND l.cv_enterprise_id IS NOT NULL
          AND l.cv_enterprise_id IN (re.idemp_cv_from_reserva, re.idemp_int_from_reserva)
        )
      )
    ORDER BY (l.cv_stage_id IS NOT NULL) DESC, l.updated_at DESC
    LIMIT 1
  ) lnk ON TRUE
),

reservas_com_cidade AS (
  SELECT
    re.*,
    ec_city.city_resolved,
    /*
      Prioridade, do mais confiável para o menos:
        1. vínculo manual (exceção configurada na tela)
        2. idetapa_int da reserva      → CC da fase, direto do CV
        3. idetapa_int do cadastro     → mesma informação, quando a reserva não traz
        4. idempreendimento_int        → só serve quando é CC de verdade
        5. enterprise_cities           → último recurso; não conhece fase, então
           aponta o empreendimento inteiro para um único CC
    */
    COALESCE(
      re.idemp_erp_link,
      re.idetapa_int_from_reserva,
      re.idetapa_int_cadastro,
      re.idemp_int_from_reserva,
      ec_city.erp_id_int
    ) AS idemp_erp_resolvido
  FROM reservas_com_link re

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
      /* 0) CC da ETAPA — o código mais preciso que o CV tem */
      (re.idetapa_int_from_reserva IS NOT NULL AND ec.erp_id = re.idetapa_int_from_reserva::text)
      OR (re.idetapa_int_cadastro IS NOT NULL AND ec.erp_id = re.idetapa_int_cadastro::text)
      /* 1) CC do bloco */
      OR (blk.idbloco_int IS NOT NULL AND ec.erp_id = regexp_replace(blk.idbloco_int, '[^0-9].*', ''))
      /* 2) idempreendimento_int é o próprio Sienge ERP ID */
      OR (re.idemp_int_from_reserva IS NOT NULL AND ec.erp_id = re.idemp_int_from_reserva::text)
      /* 3) idempreendimento_int é o CRM ID do CV */
      OR (re.idemp_int_from_reserva IS NOT NULL AND ec.crm_id = re.idemp_int_from_reserva)
      /* 4) campo idempreendimento_cv é o CRM ID do CV */
      OR (re.idemp_cv_from_reserva IS NOT NULL AND ec.crm_id = re.idemp_cv_from_reserva)
      /* Sem fallback por nome: casar texto mandava valor para o CC errado. */
    ORDER BY
      CASE
        WHEN re.idetapa_int_from_reserva IS NOT NULL AND ec.erp_id = re.idetapa_int_from_reserva::text THEN 1
        WHEN re.idetapa_int_cadastro     IS NOT NULL AND ec.erp_id = re.idetapa_int_cadastro::text     THEN 2
        WHEN blk.idbloco_int IS NOT NULL AND ec.erp_id = regexp_replace(blk.idbloco_int, '[^0-9].*', '') THEN 3
        WHEN re.idemp_int_from_reserva IS NOT NULL AND ec.erp_id = re.idemp_int_from_reserva::text THEN 4
        WHEN re.idemp_int_from_reserva IS NOT NULL AND ec.crm_id = re.idemp_int_from_reserva       THEN 5
        WHEN re.idemp_cv_from_reserva  IS NOT NULL AND ec.crm_id = re.idemp_cv_from_reserva        THEN 6
        ELSE 7
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
  ${hasEnterpriseIds
      ? `AND COALESCE(rcc.idemp_erp_resolvido, rcc.idemp_int_from_reserva) IN (:enterpriseIds)`
      : ``
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
  ${hasCompanyIds
      ? `WHERE comp.company_id IS NULL OR comp.company_id IN (:companyIds)`
      : ``
    }
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

SELECT
  rce.*,
  ls.last_status_at,
  /* Dias desde a última movimentação — o front usa para explicar o corte. */
  GREATEST(0, EXTRACT(DAY FROM (
    NOW() - COALESCE(ls.last_status_at, rce.data_reserva::timestamptz)
  ))::int) AS dias_parado
FROM reservas_com_empresa rce
LEFT JOIN last_status ls USING (idreserva)
${hasStaleCut ? `
/*
  Corte por inatividade: parado há mais de :staleDays dias deixa de contar como
  próxima entrada. Sem data nenhuma (last_status_at e data_reserva nulos) a
  reserva é mantida — não dá para afirmar que está encalhada.
*/
WHERE COALESCE(ls.last_status_at, rce.data_reserva::timestamptz) IS NULL
   OR COALESCE(ls.last_status_at, rce.data_reserva::timestamptz) >= NOW() - (:staleDays * INTERVAL '1 day')
` : ``}
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
  if (hasCompanyIds) replacements.companyIds = companyIdsSafe
  if (hasEnterpriseIds) replacements.enterpriseIds = enterpriseIdsSafe
  if (hasStaleCut) replacements.staleDays = staleDays

  const results = await db.sequelize.query(sql, {
    replacements,
    type: db.Sequelize.QueryTypes.SELECT
  })

  return {
    count: results.length,
    results,
    meta: {
      tipo,
      segmentos,
      situacoes,
      city: isAdmin ? null : userCity,
      companyIds: companyIdsSafe,
      enterpriseIds: enterpriseIdsSafe,
      staleDays: hasStaleCut ? staleDays : null
    }
  }
}
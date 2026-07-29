// src/controllers/sienge/contractSalesController.js
import dayjs from 'dayjs'
import db from '../../models/sequelize/index.js'
import { visibleErpIds } from '../../services/permissions/accessScopeService.js'

// caches globais (somente para admin em listEnterprises)
let _enterprisesCache = null
let _enterprisesCacheTs = 0

// TTL de 24 horas
const CACHE_TTL = 1000 * 60 * 60 * 24 // 24h

export async function getContracts(req, res) {
  try {
    const {
      startDate,
      endDate,
      situation,
      enterpriseName,
      view = 'dashboard',
      enterpriseId,
      enterpriseIds,
      companyId,
      companyIds
    } = req.query

    const isDetail = String(view).toLowerCase() === 'detail'

    const enterpriseIdNumRaw =
      enterpriseId != null && enterpriseId !== '' ? Number(enterpriseId) : null

    // Só IDs positivos viram filtro. Antes um ?enterpriseId=0 virava
    // "AND enterprise_id = 0" e zerava o dashboard sem erro.
    const enterpriseIdNum =
      Number.isFinite(enterpriseIdNumRaw) && enterpriseIdNumRaw > 0 ? enterpriseIdNumRaw : null

    const enterpriseIdsArr =
      typeof enterpriseIds === 'string'
        ? enterpriseIds
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n > 0)
        : []

    const hasEnterpriseIds = enterpriseIdsArr.length > 0

    const today = dayjs()
    const start = startDate ? dayjs(startDate) : today.startOf('month')
    const end = endDate ? dayjs(endDate) : today

    const validSituations = ['Emitido', 'Autorizado', 'Cancelado']
    const sit = validSituations.includes(situation) ? situation : 'Emitido'

    // filtro por nome de empreendimento (match exato, case-insensitive)
    let nameList = []
    if (Array.isArray(enterpriseName)) {
      nameList = enterpriseName.map((name) => name.trim()).filter(Boolean)
    } else if (typeof enterpriseName === 'string') {
      nameList = enterpriseName
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
    }

    const whereNameClause =
      nameList.length > 0
        ? ` AND (${nameList.map((_, i) => `LOWER(sc.enterprise_name) = LOWER(:name${i})`).join(' OR ')})`
        : ''

    const whereEnterpriseIdClause =
      enterpriseIdNum != null ? ` AND sc.enterprise_id = :enterpriseId` : ''

    // ✅ NOVO: lista de enterpriseIds (para seleção em massa)
    const whereEnterpriseIdsClause = hasEnterpriseIds
      ? ` AND sc.enterprise_id IN (:enterpriseIds)`
      : ''

    // ── Company filter ─────────────────────────────────────────────────────
    const companyIdNum = companyId != null && companyId !== '' ? Number(companyId) : null
    const companyIdSafe = Number.isFinite(companyIdNum) && companyIdNum > 0 ? companyIdNum : null

    const companyIdsArr = typeof companyIds === 'string'
      ? companyIds.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
      : []
    const hasCompanyIds = companyIdsArr.length > 0

    const whereCompanyIdClause = companyIdSafe ? ` AND sc.company_id = :companyId` : ''
    const whereCompanyIdsClause = hasCompanyIds ? ` AND sc.company_id IN (:companyIds)` : ''

    // Escopo de acesso: null = admin (sem filtro), [] = nada visível
    const scopeErpIds = await visibleErpIds(req.user)
    const isAdmin = scopeErpIds === null
    if (scopeErpIds && !scopeErpIds.length) {
      // fail-closed: escopo vazio → resultado vazio
      return res.json({ count: 0, results: [] })
    }
    const whereScopeClause = isAdmin ? '' : ` AND sc.enterprise_id IN (:scopeErpIds)`

    // ── Co-titulares (associates) ─────────────────────────────────────────────
    // Bloco caro: normaliza nome (unaccent + regex) de cada cliente do contrato
    // para descartar o titular e cônjuges repetidos. Só o modal de detalhe usa
    // esses dados, então no dashboard devolvemos array vazio e economizamos o
    // processamento em cima de TODOS os contratos do período.
    const associatesExpr = isDetail ? `COALESCE(
      (
        WITH cust AS (
          SELECT
            NULLIF(c ->> 'id','')::int                          AS cid,
            c ->> 'name'                                        AS cname,
            NULLIF(c ->> 'participationPercentage','')::numeric AS participation,
            COALESCE((c ->> 'spouse')::boolean, false)          AS is_spouse,
            (
              NULLIF(c ->> 'participationPercentage','')::numeric IS NOT NULL
              AND NULLIF(c ->> 'participationPercentage','')::numeric > 0
            )                                                   AS has_participation,
            row_number() OVER ()                                AS rn,
            regexp_replace(
              regexp_replace(
                regexp_replace(unaccent(upper(c ->> 'name')), '[^A-Z0-9]+', ' ', 'g'),
                '(^| )(DE|DA|DO|DAS|DOS|E)( |$)', ' ', 'g'
              ),
              '\\s+', '', 'g'
            ) AS cname_norm
          FROM jsonb_array_elements(b.customers) c
        ),
        main_sel AS (
          SELECT
            regexp_replace(
              regexp_replace(
                regexp_replace(unaccent(upper(
                  COALESCE(
                    (SELECT mc ->> 'name'
                     FROM jsonb_array_elements(b.customers) mc
                     WHERE (mc ->> 'main')::boolean = true
                     LIMIT 1),
                    (SELECT mc ->> 'name'
                     FROM jsonb_array_elements(b.customers) mc
                     ORDER BY (mc ->> 'id')::int NULLS LAST
                     LIMIT 1)
                  )
                )), '[^A-Z0-9]+', ' ', 'g'),
                '(^| )(DE|DA|DO|DAS|DOS|E)( |$)', ' ', 'g'
              ),
              '\\s+', '', 'g'
            ) AS main_name_norm
        ),
        picked AS (
          SELECT cname_norm, cid, cname, participation, is_spouse, has_participation, rn
          FROM (
            SELECT *,
                   row_number() OVER (
                     PARTITION BY cname_norm
                     ORDER BY is_spouse DESC, has_participation DESC, rn ASC
                   ) AS pick
            FROM cust, main_sel
            WHERE cname_norm IS NOT NULL
              AND cname_norm <> main_name_norm
          ) x
          WHERE pick = 1
        )
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'customer_id', cid,
                   'name', cname,
                   'participation_percentage', participation
                 )
                 ORDER BY is_spouse DESC, has_participation DESC, rn ASC
               )
        FROM picked
      ),
      '[]'::jsonb
    )` : `'[]'::jsonb`

    // ── Repasse / reserva ─────────────────────────────────────────────────────
    // O objeto do CV traz dezenas de campos (titular, corretor, imobiliária,
    // condições, unidade_json...) que só o modal de detalhe consome. No
    // dashboard mandamos apenas o que decide número: status do repasse (para
    // excluir distrato) e o histórico de etapas (para a regra de comissão).
    const repasseExpr = isDetail
      ? `jsonb_build_array(rf.repasse_obj)`
      : `jsonb_build_array(jsonb_build_object(
          'idrepasse',          rf.repasse_obj -> 'idrepasse',
          'idreserva',          rf.repasse_obj -> 'idreserva',
          'status_repasse',     rf.repasse_obj -> 'status_repasse',
          'idsituacao_repasse', rf.repasse_obj -> 'idsituacao_repasse',
          'status',             COALESCE(rf.repasse_obj -> 'status', '[]'::jsonb)
        ))`

    const reservaExpr = isDetail
      ? `to_jsonb(res)`
      : `jsonb_build_object(
          'idreserva',      to_jsonb(res) -> 'idreserva',
          'status_repasse', to_jsonb(res) -> 'status_repasse'
        )`

    const sql = `
WITH base AS (
  SELECT sc.*
  FROM contracts sc
  WHERE sc.financial_institution_date BETWEEN :start AND :end
    AND sc.situation = :situation
    -- Empreendimentos ocultos pelo admin somem para TODO mundo, e já no SQL:
    -- não adianta filtrar no cliente (o não-admin não enxerga a lista) nem
    -- faz sentido trafegar contrato que ninguém vai ver.
    AND NOT EXISTS (
      SELECT 1 FROM hidden_dashboard_enterprises h
      WHERE h.active = true AND h.enterprise_id = sc.enterprise_id
    )
    ${whereScopeClause}
    ${whereNameClause}
    ${whereEnterpriseIdClause}
    ${whereEnterpriseIdsClause}
    ${whereCompanyIdClause}
    ${whereCompanyIdsClause}
),

pivots AS (
  SELECT
    b.id AS contract_id,
    b.enterprise_id,
    b.enterprise_name,
    b.company_id,
    b.company_name,
    b.company_id::text AS company_id_str,
    b.financial_institution_date,

    CASE
      WHEN b.land_value IS NULL THEN NULL
      WHEN position(',' in b.land_value::text) > 0
        THEN replace(regexp_replace(b.land_value::text, '\\.', '', 'g'), ',', '.')::numeric
      ELSE
        regexp_replace(b.land_value::text, '[^0-9\\.]', '', 'g')::numeric
    END AS land_value,

    COALESCE(
      (SELECT u ->> 'name'
       FROM jsonb_array_elements(b.units) u
       WHERE (u ->> 'main')::boolean = true
       LIMIT 1),
      (SELECT u ->> 'name'
       FROM jsonb_array_elements(b.units) u
       LIMIT 1)
    ) AS unit_name,

    COALESCE(
      (SELECT NULLIF(u ->> 'id','')::int
       FROM jsonb_array_elements(b.units) u
       WHERE (u ->> 'main')::boolean = true
       LIMIT 1),
      (SELECT NULLIF(u ->> 'id','')::int
       FROM jsonb_array_elements(b.units) u
       LIMIT 1)
    ) AS unit_id,

    COALESCE(
      (SELECT c
       FROM jsonb_array_elements(b.customers) c
       WHERE (c ->> 'main')::boolean = true
       LIMIT 1),
      (SELECT c
       FROM jsonb_array_elements(b.customers) c
       ORDER BY (c ->> 'id')::int NULLS LAST
       LIMIT 1)
    ) AS main_customer,

    ${associatesExpr} AS associates,

    COALESCE(b.payment_conditions, '[]'::jsonb) AS payment_conditions,
    ${isDetail ? `COALESCE(b.links_json, '[]'::jsonb)` : `'[]'::jsonb`} AS links,

    regexp_replace(upper(
      COALESCE(
        (SELECT u ->> 'name'
        FROM jsonb_array_elements(b.units) u
        WHERE (u ->> 'main')::boolean = true
        LIMIT 1),
        (SELECT u ->> 'name'
        FROM jsonb_array_elements(b.units) u
        LIMIT 1),
        ''
      )
    ), '[^A-Z0-9]+', '', 'g') AS unit_name_norm

  FROM base b
),

ec_resolved AS (
  SELECT
    p.enterprise_id,
    COALESCE(ec.city_override, ec.default_city) AS city_resolved
  FROM (SELECT DISTINCT enterprise_id FROM pivots) p
  LEFT JOIN LATERAL (
    SELECT ec.*
    FROM enterprise_cities ec
    WHERE ec.erp_id IS NOT NULL
      AND ec.erp_id = p.enterprise_id::text
    ORDER BY ec.updated_at DESC
    LIMIT 1
  ) ec ON TRUE
),

rp_by_unit AS (
  SELECT *
  FROM (
    SELECT
      r.*,
      COALESCE(r.data_status_repasse, r.data_contrato_liberado, r.data_contrato_contab) AS data_mais_recente,
      ROW_NUMBER() OVER (
        PARTITION BY r.codigointerno_unidade::text
        ORDER BY
          (CASE WHEN r.status_repasse ILIKE 'Cancelado' THEN 1 ELSE 0 END),
          COALESCE(r.data_status_repasse, r.data_contrato_liberado, r.data_contrato_contab) DESC NULLS LAST,
          r.idrepasse DESC
      ) AS rn
    FROM repasses r
    WHERE r.codigointerno_unidade::text IN (
      SELECT DISTINCT p.unit_id::text
      FROM pivots p
      WHERE p.unit_id IS NOT NULL
    )
  ) x
  WHERE x.rn = 1
),

missing AS (
  SELECT p.*
  FROM pivots p
  LEFT JOIN rp_by_unit ru
    ON ru.codigointerno_unidade::text = p.unit_id::text
  WHERE ru.idrepasse IS NULL
),

missing_keys AS (
  SELECT DISTINCT
    m.enterprise_id::text AS ent_id,
    m.company_id_str      AS comp_prefix
  FROM missing m
),

rp_candidates_fallback AS (
  SELECT
    r.*,
    regexp_replace(upper(COALESCE(r.unidade, '')), '[^A-Z0-9]+', '', 'g') AS unidade_norm,
    COALESCE(r.data_status_repasse, r.data_contrato_liberado, r.data_contrato_contab) AS data_mais_recente
  FROM repasses r
  WHERE EXISTS (
    SELECT 1
    FROM missing_keys k
    WHERE
      r.codigointerno_empreendimento::text = k.ent_id
      OR (k.comp_prefix IS NOT NULL AND r.codigointerno_empreendimento::text LIKE k.comp_prefix || '%')
      OR (k.comp_prefix IS NOT NULL AND r.codigointerno_etapa::text LIKE k.comp_prefix || '%')
  )
),

rp_fallback_per_contract AS (
  SELECT *
  FROM (
    SELECT
      m.contract_id,
      r.*,
      ROW_NUMBER() OVER (
        PARTITION BY m.contract_id
        ORDER BY
          (CASE WHEN r.codigointerno_unidade::text = m.unit_id::text THEN 0 ELSE 1 END),
          (CASE WHEN r.status_repasse ILIKE 'Cancelado' THEN 1 ELSE 0 END),
          r.data_mais_recente DESC NULLS LAST,
          r.idrepasse DESC
      ) AS rn
    FROM missing m
    JOIN rp_candidates_fallback r
      ON r.unidade_norm = m.unit_name_norm
     AND (
       r.codigointerno_empreendimento::text = m.enterprise_id::text
       OR r.codigointerno_empreendimento::text LIKE m.company_id_str || '%'
       OR r.codigointerno_etapa::text LIKE m.company_id_str || '%'
     )
  ) x
  WHERE x.rn = 1
),

rp_final AS (
  SELECT
    p.contract_id,
    COALESCE(ru.idrepasse, rf.idrepasse) AS idrepasse,
    COALESCE(ru.idreserva, rf.idreserva) AS idreserva,
    COALESCE(to_jsonb(ru), to_jsonb(rf)) AS repasse_obj
  FROM pivots p
  LEFT JOIN rp_by_unit ru
    ON ru.codigointerno_unidade::text = p.unit_id::text
  LEFT JOIN rp_fallback_per_contract rf
    ON rf.contract_id = p.contract_id
)

SELECT
  p.contract_id,
  p.enterprise_id,
  p.enterprise_name,
  p.company_id AS company_id,
  p.company_name AS company_name,
  p.financial_institution_date,
  p.unit_name,
  p.unit_id,
  p.land_value,

  NULLIF(p.main_customer ->> 'id','')::int                           AS customer_id,
  (p.main_customer ->> 'name')                                       AS customer_name,
  NULLIF(p.main_customer ->> 'participationPercentage', '')::numeric AS participation_percentage,

  p.associates,
  p.payment_conditions,
  p.links,

  ec.city_resolved AS erp_city,

  CASE
    WHEN rf.repasse_obj IS NOT NULL THEN ${repasseExpr}
    ELSE '[]'::jsonb
  END AS repasse,

  CASE
    WHEN res.idreserva IS NOT NULL THEN ${reservaExpr}
    ELSE NULL
  END AS reserva

FROM pivots p
LEFT JOIN ec_resolved ec
  ON ec.enterprise_id = p.enterprise_id

LEFT JOIN rp_final rf
  ON rf.contract_id = p.contract_id

LEFT JOIN reservas res
  ON res.idreserva = rf.idreserva

ORDER BY p.financial_institution_date, p.contract_id;
`
    // A visibilidade por escopo já foi aplicada na CTE base (whereScopeClause);
    // ec_resolved segue existindo apenas para expor erp_city no payload.
    const replacements = {
      start: start.format('YYYY-MM-DD'),
      end: end.format('YYYY-MM-DD'),
      situation: sit
    }

    if (!isAdmin) {
      replacements.scopeErpIds = scopeErpIds
    }

    if (Number.isFinite(enterpriseIdNum)) {
      replacements.enterpriseId = enterpriseIdNum
    }

    if (hasEnterpriseIds) {
      replacements.enterpriseIds = enterpriseIdsArr
    }

    if (companyIdSafe) {
      replacements.companyId = companyIdSafe
    }

    if (hasCompanyIds) {
      replacements.companyIds = companyIdsArr
    }

    nameList.forEach((val, i) => {
      replacements[`name${i}`] = val
    })

    const results = await db.sequelize.query(sql, {
      replacements,
      type: db.Sequelize.QueryTypes.SELECT
    })

    return res.json({ count: results.length, results })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao buscar contratos.' })
  }
}

export async function listEnterprises(req, res) {
  try {
    // Escopo de acesso: null = admin (sem filtro), [] = nada visível
    const erpIds = await visibleErpIds(req.user)
    const isAdmin = erpIds === null

    // 🔁 Cache só para admin
    if (isAdmin && _enterprisesCache && Date.now() - _enterprisesCacheTs < CACHE_TTL) {
      return res.json({ count: _enterprisesCache.length, results: _enterprisesCache })
    }

    if (isAdmin) {
      const sqlAdmin = `
        SELECT DISTINCT ON (sc.enterprise_id)
          sc.enterprise_id AS id,
          sc.enterprise_name AS name,
          sc.company_id,
          sc.company_name
        FROM contracts sc
        ORDER BY
          sc.enterprise_id,
          sc.financial_institution_date DESC NULLS LAST,
          sc.id DESC;
      `

      const rows = await db.sequelize.query(sqlAdmin, {
        type: db.Sequelize.QueryTypes.SELECT
      })

      const results = rows.map((r) => ({ id: r.id, name: r.name, company_id: r.company_id ?? null, company_name: r.company_name ?? null }))
      _enterprisesCache = results
      _enterprisesCacheTs = Date.now()

      return res.json({ count: results.length, results })
    }

    // 🔒 Não-admin: mesma lógica, mas com filtro por escopo de acesso
    // fail-closed: escopo vazio → lista vazia
    if (!erpIds.length) {
      return res.json({ count: 0, results: [] })
    }

    const sqlNonAdmin = `
      SELECT DISTINCT ON (sc.enterprise_id)
        sc.enterprise_id AS id,
        sc.enterprise_name AS name,
        sc.company_id,
        sc.company_name
      FROM contracts sc
      WHERE sc.enterprise_id IN (:erpIds)
      ORDER BY
        sc.enterprise_id,
        sc.financial_institution_date DESC NULLS LAST,
        sc.id DESC;
    `

    const filtered = await db.sequelize.query(sqlNonAdmin, {
      replacements: { erpIds },
      type: db.Sequelize.QueryTypes.SELECT
    })

    return res.json({ count: filtered.length, results: filtered })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar empreendimentos.' })
  }
}

export async function clearCache(req, res) {
  _enterprisesCache = null
  _enterprisesCacheTs = 0
  return res.json({ message: 'Caches limpos.' })
}

/**
 * GET /api/sienge/contracts/companies
 * Lista empresas (company_id + company_name) distintas dos contratos.
 * Admin vê todas; não-admin vê apenas as do seu escopo de acesso.
 */
export async function listCompanies(req, res) {
  try {
    // Escopo de acesso: null = admin (sem filtro), [] = nada visível
    const erpIds = await visibleErpIds(req.user)
    const isAdmin = erpIds === null

    // fail-closed: escopo vazio → lista vazia
    if (!isAdmin && !erpIds.length) {
      return res.json({ count: 0, results: [] })
    }

    const sqlAdmin = `
      SELECT DISTINCT
        sc.company_id  AS id,
        sc.company_name AS name
      FROM contracts sc
      WHERE sc.company_id IS NOT NULL
        AND sc.company_name IS NOT NULL
      ORDER BY sc.company_name;
    `

    const sqlNonAdmin = `
      SELECT DISTINCT
        sc.company_id  AS id,
        sc.company_name AS name
      FROM contracts sc
      WHERE sc.company_id IS NOT NULL
        AND sc.company_name IS NOT NULL
        AND sc.enterprise_id IN (:erpIds)
      ORDER BY sc.company_name;
    `

    const rows = await db.sequelize.query(
      isAdmin ? sqlAdmin : sqlNonAdmin,
      {
        replacements: isAdmin ? {} : { erpIds },
        type: db.Sequelize.QueryTypes.SELECT,
      }
    )

    return res.json({ count: rows.length, results: rows.map((r) => ({ id: r.id, name: r.name })) })
  } catch (err) {
    console.error('[listCompanies]', err)
    return res.status(500).json({ error: 'Erro ao listar empresas.' })
  }
}

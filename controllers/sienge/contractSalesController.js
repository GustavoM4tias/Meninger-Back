// src/controllers/sienge/contractSalesController.js
import dayjs from 'dayjs'
import db from '../../models/sequelize/index.js'

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
      enterpriseIds
    } = req.query

    const isDetail = String(view).toLowerCase() === 'detail'

    const enterpriseIdNum =
      enterpriseId != null && enterpriseId !== '' ? Number(enterpriseId) : null

    const enterpriseIdsArr =
      typeof enterpriseIds === 'string'
        ? enterpriseIds
          .split(',')
          .map((s) => Number(s.trim()))
          .filter(Number.isFinite)
        : []

    const hasEnterpriseIds = enterpriseIdsArr.length > 0

    const today = dayjs()
    const start = startDate ? dayjs(startDate) : today.startOf('month')
    const end = endDate ? dayjs(endDate) : today

    const validSituations = ['Emitido', 'Autorizado', 'Cancelado']
    const sit = validSituations.includes(situation) ? situation : 'Emitido'

    // filtro por nome de empreendimento (lista)
    let nameList = []
    if (Array.isArray(enterpriseName)) {
      nameList = enterpriseName.map((name) => `%${name.trim()}%`)
    } else if (typeof enterpriseName === 'string') {
      nameList = enterpriseName
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
        .map((name) => `%${name}%`)
    }

    const whereNameClause =
      nameList.length > 0
        ? ` AND (${nameList.map((_, i) => `sc.enterprise_name ILIKE :name${i}`).join(' OR ')})`
        : ''

    const whereEnterpriseIdClause =
      Number.isFinite(enterpriseIdNum) ? ` AND sc.enterprise_id = :enterpriseId` : ''

    // ✅ NOVO: lista de enterpriseIds (para seleção em massa)
    const whereEnterpriseIdsClause = hasEnterpriseIds
      ? ` AND sc.enterprise_id IN (:enterpriseIds)`
      : ''

    const isAdmin = req.user?.role === 'admin'
    const userCityRaw = isAdmin ? null : (req.user?.city || null)

    // ⚠️ Se quiser habilitar fallback por nome (caro), mude para true.
    const ENABLE_REPASSE_NAME_FALLBACK = false

    const sql = `
WITH base AS (
  SELECT sc.*
  FROM contracts sc
  WHERE sc.financial_institution_date BETWEEN :start AND :end
    AND sc.situation = :situation
    ${whereNameClause}
    ${whereEnterpriseIdClause}
    ${whereEnterpriseIdsClause}
),

pivots AS (
  SELECT
    b.id AS contract_id,
    b.enterprise_id,
    b.enterprise_name,
    b.company_id,
    b.company_id::text AS company_id_str,
    b.financial_institution_date,

    CASE
      WHEN b.land_value IS NULL THEN NULL
      WHEN position(',' in b.land_value::text) > 0
        THEN replace(regexp_replace(b.land_value::text, '\.', '', 'g'), ',', '.')::numeric
      ELSE
        regexp_replace(b.land_value::text, '[^0-9\.]', '', 'g')::numeric
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

    /* ✅ VOLTA associates (igual ao antigo) */
    COALESCE(
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
              '\s+', '', 'g'
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
              '\s+', '', 'g'
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
    ) AS associates,

    COALESCE(b.payment_conditions, '[]'::jsonb) AS payment_conditions,

    /* ✅ Igual ao antigo: campo chama links */
    COALESCE(b.links_json, '[]'::jsonb) AS links,

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

/* 1) melhor repasse por unit_id (rápido) */
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

/* 2) candidatos fallback: reduz pelo empreendimento/etapa (indexável) */
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

/* 2b) melhor repasse por contrato (somente missing) — com id_match priorizado */
rp_fallback_per_contract AS (
  SELECT *
  FROM (
    SELECT
      m.contract_id,
      r.*,
      ROW_NUMBER() OVER (
        PARTITION BY m.contract_id
        ORDER BY
          /* equivalente ao antigo: id_match primeiro */
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

/* repasse final: prioriza unit_id, senão fallback
   ✅ carrega idreserva junto (pra linkar reservas corretamente)
*/
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
  p.financial_institution_date,
  p.unit_name,
  p.unit_id,
  p.land_value,

  NULLIF(p.main_customer ->> 'id','')::int                           AS customer_id,
  (p.main_customer ->> 'name')                                       AS customer_name,
  NULLIF(p.main_customer ->> 'participationPercentage', '')::numeric AS participation_percentage,

  /* ✅ igual ao antigo */
  p.associates,
  p.payment_conditions,
  p.links,

  ec.city_resolved AS erp_city,

  CASE
    WHEN rf.repasse_obj IS NOT NULL THEN jsonb_build_array(rf.repasse_obj)
    ELSE '[]'::jsonb
  END AS repasse,

  CASE
    WHEN res.idreserva IS NOT NULL THEN to_jsonb(res)
    ELSE NULL
  END AS reserva

FROM pivots p
LEFT JOIN ec_resolved ec
  ON ec.enterprise_id = p.enterprise_id

LEFT JOIN rp_final rf
  ON rf.contract_id = p.contract_id

/* ✅ CORRIGIDO: reserva liga por idreserva do repasse */
LEFT JOIN reservas res
  ON res.idreserva = rf.idreserva

WHERE
  (
    :isAdmin = TRUE
    OR (
      ec.city_resolved IS NOT NULL
      AND unaccent(upper(regexp_replace(ec.city_resolved, '[^A-Z0-9]+',' ','g'))) =
          unaccent(upper(regexp_replace(COALESCE(:userCity,''), '[^A-Z0-9]+',' ','g')))
    )
  )

ORDER BY p.financial_institution_date, p.contract_id;

`

    const replacements = {
      start: start.format('YYYY-MM-DD'),
      end: end.format('YYYY-MM-DD'),
      situation: sit,
      isAdmin,
      userCity: userCityRaw
    }

    if (Number.isFinite(enterpriseIdNum)) {
      replacements.enterpriseId = enterpriseIdNum
    }

    if (hasEnterpriseIds) {
      replacements.enterpriseIds = enterpriseIdsArr
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
    const isAdmin = req.user?.role === 'admin'

    // 🔁 Cache só para admin
    if (isAdmin && _enterprisesCache && Date.now() - _enterprisesCacheTs < CACHE_TTL) {
      return res.json({ count: _enterprisesCache.length, results: _enterprisesCache })
    }

    if (isAdmin) {
      const sqlAdmin = `
        SELECT DISTINCT ON (sc.enterprise_id)
          sc.enterprise_id AS id,
          sc.enterprise_name AS name
        FROM contracts sc
        ORDER BY
          sc.enterprise_id,
          sc.financial_institution_date DESC NULLS LAST,
          sc.id DESC;
      `

      const rows = await db.sequelize.query(sqlAdmin, {
        type: db.Sequelize.QueryTypes.SELECT
      })

      const results = rows.map((r) => ({ id: r.id, name: r.name }))
      _enterprisesCache = results
      _enterprisesCacheTs = Date.now()

      return res.json({ count: results.length, results })
    }

    // 🔒 Não-admin: mesma lógica, mas com filtro por cidade
    const userCity = req.user?.city || ''
    if (!userCity.trim()) {
      return res.status(403).json({ error: 'Cidade do usuário não configurada.' })
    }

    const sqlNonAdmin = `
      SELECT DISTINCT ON (sc.enterprise_id)
        sc.enterprise_id AS id,
        sc.enterprise_name AS name
      FROM contracts sc
      LEFT JOIN LATERAL (
        SELECT COALESCE(ec.city_override, ec.default_city) AS city_resolved
        FROM enterprise_cities ec
        WHERE ec.erp_id IS NOT NULL
          AND ec.erp_id = sc.enterprise_id::text
        ORDER BY ec.updated_at DESC
        LIMIT 1
      ) ec_erp ON TRUE
      WHERE
        ec_erp.city_resolved IS NOT NULL
        AND unaccent(upper(regexp_replace(ec_erp.city_resolved, '[^A-Z0-9]+',' ','g'))) =
            unaccent(upper(regexp_replace(:userCity, '[^A-Z0-9]+',' ','g')))
      ORDER BY
        sc.enterprise_id,
        sc.financial_institution_date DESC NULLS LAST,
        sc.id DESC;
    `

    const filtered = await db.sequelize.query(sqlNonAdmin, {
      replacements: { userCity },
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

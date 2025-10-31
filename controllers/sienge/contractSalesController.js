// src/controllers/sienge/contractSalesController.js
import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';

// caches globais (somente para admin em listEnterprises)
let _enterprisesCache = null;
let _enterprisesCacheTs = 0;

// TTL de 24 horas
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24h

export async function getContracts(req, res) {
  try {
    const { startDate, endDate, situation, enterpriseName } = req.query;

    const today = dayjs();
    const start = startDate ? dayjs(startDate) : today.startOf('month');
    const end = endDate ? dayjs(endDate) : today;

    const validSituations = ['Emitido', 'Autorizado', 'Cancelado'];
    const sit = validSituations.includes(situation) ? situation : 'Emitido';

    // filtro por nome de empreendimento (lista)
    let nameList = [];
    if (Array.isArray(enterpriseName)) {
      nameList = enterpriseName.map((name) => `%${name.trim()}%`);
    } else if (typeof enterpriseName === 'string') {
      nameList = enterpriseName
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
        .map((name) => `%${name}%`);
    }

    const whereNameClause =
      nameList.length > 0
        ? ` AND (${nameList.map((_, i) => `sc.enterprise_name ILIKE :name${i}`).join(' OR ')})`
        : '';

    const isAdmin = req.user?.role === 'admin';
    const userCityRaw = isAdmin ? null : (req.user?.city || null);

    // 🔽 Query base (seu pipeline atual) + resolução de cidade ERP e filtro por cidade no SQL
    const sql = `
WITH base AS (
  SELECT sc.*
  FROM contracts sc
  WHERE sc.financial_institution_date BETWEEN :start AND :end
    AND sc.situation = :situation
    ${whereNameClause}
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
            unaccent(upper(c ->> 'name'))                                                   AS cname_up,
            regexp_replace(unaccent(upper(c ->> 'name')), '[^A-Z0-9]+', ' ', 'g')           AS cname_spc,
            regexp_replace(
              regexp_replace(unaccent(upper(c ->> 'name')), '[^A-Z0-9]+', ' ', 'g'),
              '(^| )(DE|DA|DO|DAS|DOS|E)( |$)', ' ', 'g'
            )                                                                               AS cname_nostop_spc,
            regexp_replace(
              regexp_replace(
                regexp_replace(unaccent(upper(c ->> 'name')), '[^A-Z0-9]+', ' ', 'g'),
                '(^| )(DE|DA|DO|DAS|DOS|E)( |$)', ' ', 'g'
              ),
              '\\s+', '', 'g'
            )                                                                               AS cname_norm
          FROM jsonb_array_elements(b.customers) c
        ),
        main_sel AS (
          SELECT
            COALESCE(
              (SELECT NULLIF(mc ->> 'id','')::int
               FROM jsonb_array_elements(b.customers) mc
               WHERE (mc ->> 'main')::boolean = true
               LIMIT 1),
              (SELECT NULLIF(mc ->> 'id','')::int
               FROM jsonb_array_elements(b.customers) mc
               ORDER BY NULLIF(mc ->> 'id','')::int NULLS LAST
               LIMIT 1)
            ) AS main_id,
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
            ) AS main_name_spc,
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
    ) AS associates,

    COALESCE(b.payment_conditions, '[]'::jsonb) AS payment_conditions,
    COALESCE(b.links_json, '[]'::jsonb)         AS links,

    regexp_replace(unaccent(upper(
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
    )), '[^A-Z0-9]+', '', 'g') AS unit_name_norm
  FROM base b
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
  p.associates,
  p.payment_conditions,
  p.links,
  COALESCE(rp.repasse, '[]'::jsonb) AS repasse,
  rp.reservas->0 AS reserva,

  /* ✅ cidade ERP resolvida no SQL */
  ec_erp.city_resolved AS erp_city

FROM pivots p

/* 🔎 LATERAL: resolve cidade do ERP pelo enterprise_id */
LEFT JOIN LATERAL (
  SELECT COALESCE(ec.city_override, ec.default_city) AS city_resolved
  FROM enterprise_cities ec
  WHERE ec.source = 'erp'
    AND ec.erp_id = p.enterprise_id::text
  ORDER BY ec.updated_at DESC
  LIMIT 1
) ec_erp ON TRUE

/* Seu join lateral de repasses permanece */
LEFT JOIN LATERAL (
  SELECT
    jsonb_agg(to_jsonb(r))            AS repasse,
    jsonb_agg(DISTINCT to_jsonb(res)) AS reservas
  FROM (
    SELECT
      r.*,
      (r.codigointerno_unidade::text = p.unit_id::text) AS id_match,
      COALESCE(r.data_status_repasse, r.data_contrato_liberado, r.data_contrato_contab) AS data_mais_recente
    FROM repasses r
    WHERE
      r.codigointerno_unidade::text = p.unit_id::text
      OR (
        regexp_replace(unaccent(upper(COALESCE(r.unidade, ''))), '[^A-Z0-9]+', '', 'g') = p.unit_name_norm
        AND r.codigointerno_empreendimento::text = p.enterprise_id::text
      )
      OR (
        regexp_replace(unaccent(upper(COALESCE(r.unidade, ''))), '[^A-Z0-9]+', '', 'g') = p.unit_name_norm
        AND r.codigointerno_empreendimento::text LIKE p.company_id_str || '%'
      )
    ORDER BY
      id_match DESC,
      (CASE WHEN r.status_repasse ILIKE 'Cancelado' THEN 1 ELSE 0 END),
      data_mais_recente DESC NULLS LAST
    LIMIT 1
  ) r
  LEFT JOIN reservas res
    ON res.idreserva = r.idreserva
) rp ON TRUE

WHERE
  /* Admin vê tudo; não-admin filtra por cidade normalizada */
  (
    :isAdmin = TRUE
    OR (
      ec_erp.city_resolved IS NOT NULL
      AND unaccent(upper(regexp_replace(ec_erp.city_resolved, '[^A-Z0-9]+',' ','g'))) =
          unaccent(upper(regexp_replace(:userCity, '[^A-Z0-9]+',' ','g')))
    )
  )

ORDER BY p.financial_institution_date, p.contract_id;
`;

    const replacements = {
      start: start.format('YYYY-MM-DD'),
      end: end.format('YYYY-MM-DD'),
      situation: sit,
      isAdmin,
      userCity: userCityRaw,
    };
    nameList.forEach((val, i) => {
      replacements[`name${i}`] = val;
    });

    const results = await db.sequelize.query(sql, {
      replacements,
      type: db.Sequelize.QueryTypes.SELECT,
    });

    return res.json({ count: results.length, results });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao buscar contratos.' });
  }
}

export async function listEnterprises(req, res) {
  try {
    const isAdmin = req.user?.role === 'admin';

    // Admin: usa cache (id, name)
    if (isAdmin && _enterprisesCache && Date.now() - _enterprisesCacheTs < CACHE_TTL) {
      return res.json({ count: _enterprisesCache.length, results: _enterprisesCache });
    }

    if (isAdmin) {
      // carrega lista base (sem filtro de cidade) e cacheia
      const rows = await db.SalesContract.findAll({
        attributes: [
          ['enterprise_id', 'id'],
          ['enterprise_name', 'name'],
        ],
        group: ['enterprise_id', 'enterprise_name'],
        order: [['enterprise_name', 'ASC']],
      });

      const results = rows.map((e) => ({ id: e.get('id'), name: e.get('name') }));
      _enterprisesCache = results;
      _enterprisesCacheTs = Date.now();
      return res.json({ count: results.length, results });
    }

    // Não-admin: traz só os empreendimentos da cidade do usuário (ERP-only), direto no SQL
    const userCity = req.user?.city || '';
    if (!userCity.trim()) {
      return res.status(403).json({ error: 'Cidade do usuário não configurada.' });
    }

    const sql = `
      SELECT DISTINCT
        sc.enterprise_id AS id,
        sc.enterprise_name AS name
      FROM contracts sc
      /* resolve cidade ERP para cada enterprise_id */
      LEFT JOIN LATERAL (
        SELECT COALESCE(ec.city_override, ec.default_city) AS city_resolved
        FROM enterprise_cities ec
        WHERE ec.source = 'erp'
          AND ec.erp_id = sc.enterprise_id::text
        ORDER BY ec.updated_at DESC
        LIMIT 1
      ) ec_erp ON TRUE
      WHERE
        ec_erp.city_resolved IS NOT NULL
        AND unaccent(upper(regexp_replace(ec_erp.city_resolved, '[^A-Z0-9]+',' ','g'))) =
            unaccent(upper(regexp_replace(:userCity, '[^A-Z0-9]+',' ','g')))
      ORDER BY sc.enterprise_name ASC;
    `;

    const filtered = await db.sequelize.query(sql, {
      replacements: { userCity },
      type: db.Sequelize.QueryTypes.SELECT,
    });

    return res.json({ count: filtered.length, results: filtered });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao listar empreendimentos.' });
  }
}

export async function clearCache(req, res) {
  _enterprisesCache = null;
  _enterprisesCacheTs = 0;
  return res.json({ message: 'Caches limpos.' });
}

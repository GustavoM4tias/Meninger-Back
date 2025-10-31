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
    const { startDate, endDate, situation, enterpriseName, workflowGroupId, workflowGroupIds } = req.query;

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
        ? ` AND (${nameList.map((_, i) => `ent_name ILIKE :name${i}`).join(' OR ')})`
        : '';

    const isAdmin = req.user?.role === 'admin';
    const userCityRaw = isAdmin ? null : (req.user?.city || null);

    // ====== múltiplos grupos ======
    const ids = (() => {
      if (workflowGroupIds) {
        if (Array.isArray(workflowGroupIds)) return workflowGroupIds.map(Number).filter(Boolean);
        return String(workflowGroupIds).split(',').map((x) => Number(x.trim())).filter(Boolean);
      }
      if (workflowGroupId) return [Number(workflowGroupId)];
      return [];
    })();

    // Carrega grupos (se houver)
    let groupsData = [];
    if (ids.length) {
      // monta literal PG array: "{1,2,3}"
      const idsPgArray = `{${ids.join(',')}}`;

      const query = `
    SELECT idgroup, tipo, situacoes_ids::jsonb AS situacoes_ids
      FROM cv_workflow_groups
     WHERE ativo = TRUE
       AND idgroup = ANY(CAST(:idsPgArray AS int[]))
     ORDER BY idgroup;
  `;

      groupsData = await db.sequelize.query(query, {
        replacements: { idsPgArray },
        type: db.Sequelize.QueryTypes.SELECT,
      });

      if (groupsData.length === 0) {
        return res.status(400).json({ error: 'Nenhum grupo de workflow válido/ativo encontrado.' });
      }
    }

    // Monta JSON para o SQL (array de objetos { tipo, sit_ids[int[]] })
    const groupsJson =
      groupsData.length > 0
        ? JSON.stringify(
          groupsData.map((g) => ({
            tipo: g.tipo,
            sit_ids: Array.isArray(g.situacoes_ids) ? g.situacoes_ids.map(Number) : [],
          }))
        )
        : null;

    // ====== SQL ======
    const sql =
      groupsJson == null
        ? `
/* ========= PIPELINE ORIGINAL (sem grupo) ========= */
WITH base AS (
  SELECT sc.*
  FROM contracts sc
  WHERE sc.financial_institution_date BETWEEN :start AND :end
    AND sc.situation = :situation
),
pivots AS (
  SELECT
    b.id AS contract_id,
    b.enterprise_id,
    b.enterprise_name AS ent_name,
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
  p.ent_name AS enterprise_name,
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
  ec_erp.city_resolved AS erp_city
FROM pivots p
LEFT JOIN LATERAL (
  SELECT COALESCE(ec.city_override, ec.default_city) AS city_resolved
  FROM enterprise_cities ec
  WHERE ec.source = 'erp'
    AND ec.erp_id = p.enterprise_id::text
  ORDER BY ec.updated_at DESC
  LIMIT 1
) ec_erp ON TRUE
LEFT JOIN LATERAL (
  SELECT
    jsonb_agg(to_jsonb(r.*))            AS repasse,
    jsonb_agg(DISTINCT to_jsonb(res.*)) AS reservas
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
  (
    :isAdmin = TRUE
    OR (
      ec_erp.city_resolved IS NOT NULL
      AND unaccent(upper(regexp_replace(ec_erp.city_resolved, '[^A-Z0-9]+',' ','g'))) =
          unaccent(upper(regexp_replace(:userCity, '[^A-Z0-9]+',' ','g')))
    )
  )
${whereNameClause}
ORDER BY p.financial_institution_date, p.contract_id;
`
        : `
/* ========= PIPELINE COM GRUPOS (contracts + reservas) ========= */
WITH group_cfg AS (
  SELECT
    (g->>'tipo')::text AS tipo,
    ARRAY(
      SELECT (elem)::int FROM jsonb_array_elements_text(g->'sit_ids') elem
    ) AS sit_ids
  FROM jsonb_array_elements(:groups_json::jsonb) g
),

/* ---- CONTRATOS ---- */
contracts_base AS (
  SELECT sc.*
  FROM contracts sc
  WHERE sc.financial_institution_date BETWEEN :start AND :end
    AND sc.situation = :situation
),
contracts_pivot AS (
  SELECT
    b.id AS contract_id,
    b.enterprise_id,
    b.enterprise_name AS ent_name,
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
  FROM contracts_base b
),
contracts_city AS (
  SELECT p.*,
         COALESCE(ec.city_override, ec.default_city) AS erp_city
  FROM contracts_pivot p
  LEFT JOIN LATERAL (
    SELECT *
    FROM enterprise_cities ec
    WHERE ec.source = 'erp'
      AND ec.erp_id = p.enterprise_id::text
    ORDER BY ec.updated_at DESC
    LIMIT 1
  ) ec ON TRUE
),
contracts_enriched AS (
  SELECT
    c.*,
    rp.repasse,
    rp.reservas,
    rp.latest_idsituacao_repasse,
    rp.idsituacao_reserva_atual
  FROM contracts_city c
  LEFT JOIN LATERAL (
    SELECT
      jsonb_agg(to_jsonb(r.*))                      AS repasse,
      jsonb_agg(DISTINCT to_jsonb(res.*))           AS reservas,
      /* mais recente idsituacao_repasse (do JSON da reserva correlata quando existir) */
      /* tornar compatível com agregação usando MIN(...) */
      MIN((
        SELECT (s->>'idsituacao_repasse')::int
        FROM jsonb_path_query(res.status, '$[*]') s
        ORDER BY
          COALESCE((s->>'captured_at')::timestamptz, now() - interval '100 years') DESC,
          COALESCE((s->>'data_status_repasse')::timestamptz, now() - interval '100 years') DESC
        LIMIT 1
      ))                                            AS latest_idsituacao_repasse,
      MIN((res.situacao->>'idsituacao')::int)       AS idsituacao_reserva_atual

    FROM (
      SELECT
        r.*,
        (r.codigointerno_unidade::text = c.unit_id::text) AS id_match,
        COALESCE(r.data_status_repasse, r.data_contrato_liberado, r.data_contrato_contab) AS data_mais_recente
      FROM repasses r
      WHERE
        r.codigointerno_unidade::text = c.unit_id::text
        OR (
          regexp_replace(unaccent(upper(COALESCE(r.unidade, ''))), '[^A-Z0-9]+', '', 'g') = c.unit_name_norm
          AND r.codigointerno_empreendimento::text = c.enterprise_id::text
        )
        OR (
          regexp_replace(unaccent(upper(COALESCE(r.unidade, ''))), '[^A-Z0-9]+', '', 'g') = c.unit_name_norm
          AND r.codigointerno_empreendimento::text LIKE c.company_id_str || '%'
        )
      ORDER BY
        id_match DESC,
        (CASE WHEN r.status_repasse ILIKE 'Cancelado' THEN 1 ELSE 0 END),
        data_mais_recente DESC NULLS LAST
      LIMIT 1
    ) r
    LEFT JOIN reservas res ON res.idreserva = r.idreserva
  ) rp ON TRUE
),
contracts_filtered AS (
  SELECT *
  FROM contracts_enriched c
  WHERE
    (
      :isAdmin = TRUE
      OR (
        c.erp_city IS NOT NULL
        AND unaccent(upper(regexp_replace(c.erp_city, '[^A-Z0-9]+',' ','g'))) =
            unaccent(upper(regexp_replace(:userCity, '[^A-Z0-9]+',' ','g')))
      )
    )
    ${whereNameClause}
    AND EXISTS (
      SELECT 1
      FROM group_cfg g
      WHERE
        (g.tipo = 'repasses' AND c.latest_idsituacao_repasse = ANY (g.sit_ids))
        OR
        (g.tipo = 'reservas' AND c.idsituacao_reserva_atual = ANY (g.sit_ids))
    )
),

/* ---- RESERVAS puras, filtradas por grupos e cidade, e deduplicadas contra contratos ---- */
reservas_latest AS (
  SELECT
    r.*,
    /* status mais recente (idsituacao_repasse) */
    (
      SELECT (s->>'idsituacao_repasse')::int
      FROM jsonb_path_query(r.status, '$[*]') s
      ORDER BY
        COALESCE((s->>'captured_at')::timestamptz, now() - interval '100 years') DESC,
        COALESCE((s->>'data_status_repasse')::timestamptz, now() - interval '100 years') DESC
      LIMIT 1
    ) AS latest_idsituacao_repasse,
    /* timestamp para filtro de período */
    COALESCE(
      (SELECT (s->>'data_status_repasse')::timestamptz
       FROM jsonb_path_query(r.status, '$[*]') s
       ORDER BY
         COALESCE((s->>'captured_at')::timestamptz, now() - interval '100 years') DESC,
         COALESCE((s->>'data_status_repasse')::timestamptz, now() - interval '100 years') DESC
       LIMIT 1
      ),
      r.data_reserva
    ) AS latest_ts
  FROM reservas r
),
reservas_group AS (
  SELECT rl.*
  FROM reservas_latest rl
  WHERE
    rl.latest_ts BETWEEN :start AND :end
    AND EXISTS (
      SELECT 1
      FROM group_cfg g
      WHERE
        (g.tipo = 'repasses' AND rl.latest_idsituacao_repasse = ANY (g.sit_ids))
        OR
        (g.tipo = 'reservas' AND (rl.situacao->>'idsituacao')::int = ANY (g.sit_ids))
    )
),
reservas_city AS (
  SELECT
    rg.*,
    COALESCE(rg.unidade_json->>'idempreendimento_int', (rg.unidade_json->>'idempreendimento_cv')) AS enterprise_id_txt,
    COALESCE(rg.unidade_json->>'empreendimento', rg.empreendimento) AS ent_name,
    rg.unidade AS unit_name,
    NULLIF(rg.unidade_json->>'idunidade_int','') AS unit_id_txt,
    regexp_replace(unaccent(upper(COALESCE(rg.unidade, ''))), '[^A-Z0-9]+', '', 'g') AS unit_name_norm,
    COALESCE(ec.city_override, ec.default_city) AS erp_city
  FROM reservas_group rg
  LEFT JOIN LATERAL (
    SELECT *
    FROM enterprise_cities ec
    WHERE ec.source = 'erp'
      AND ec.erp_id = COALESCE(rg.unidade_json->>'idempreendimento_int', rg.unidade_json->>'idempreendimento_cv')
    ORDER BY ec.updated_at DESC
    LIMIT 1
  ) ec ON TRUE
),
reservas_city_filtered AS (
  SELECT *
  FROM reservas_city
  WHERE
    (
      :isAdmin = TRUE
      OR (
        erp_city IS NOT NULL
        AND unaccent(upper(regexp_replace(erp_city, '[^A-Z0-9]+',' ','g'))) =
            unaccent(upper(regexp_replace(:userCity, '[^A-Z0-9]+',' ','g')))
      )
    )
    ${whereNameClause}
),
reservas_dedup AS (
  SELECT rf.*
  FROM reservas_city_filtered rf
  WHERE NOT EXISTS (
    /* 1) dedup por unit_id dentro do mesmo enterprise */
    SELECT 1
    FROM contracts c
    WHERE
      (
        (rf.unit_id_txt IS NOT NULL AND rf.unit_id_txt <> '')
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(c.units) u
          WHERE NULLIF(u->>'id','')::text = rf.unit_id_txt
        )
      )
      AND c.enterprise_id::text = rf.enterprise_id_txt
    UNION ALL
    /* 2) fallback por nome normalizado da unidade dentro do mesmo enterprise */
    SELECT 1
    FROM contracts c
    WHERE
      EXISTS (
        SELECT 1
        FROM jsonb_array_elements(c.units) u
        WHERE regexp_replace(unaccent(upper(COALESCE(u->>'name',''))), '[^A-Z0-9]+', '', 'g') = rf.unit_name_norm
      )
      AND c.enterprise_id::text = rf.enterprise_id_txt
  )
)

/* ==== RESULTADO FINAL: UNION de contratos (filtrados) + reservas (deduplicadas) ==== */
SELECT
  c.contract_id,
  c.enterprise_id,
  c.ent_name AS enterprise_name,
  c.financial_institution_date,
  c.unit_name,
  c.unit_id,
  c.land_value,
  NULLIF(c.main_customer ->> 'id','')::int                           AS customer_id,
  (c.main_customer ->> 'name')                                       AS customer_name,
  NULLIF(c.main_customer ->> 'participationPercentage', '')::numeric AS participation_percentage,
  COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object('customer_id', NULLIF(cc->>'id','')::int, 'name', cc->>'name', 'participation_percentage', NULLIF(cc->>'participationPercentage','')::numeric)
    )
    FROM jsonb_path_query_array(to_jsonb(c.*), '$.associates') as t(cc)
  ), '[]'::jsonb) AS associates, /* safe */
  c.payment_conditions,
  c.links,
  COALESCE(c.repasse, '[]'::jsonb) AS repasse,
  (SELECT c.reservas->0) AS reserva,
  c.erp_city,
  'contract'::text AS origin
FROM contracts_filtered c

UNION ALL

SELECT
  NULL::int AS contract_id,
  (reservas_dedup.enterprise_id_txt)::int AS enterprise_id,
  reservas_dedup.ent_name AS enterprise_name,
  reservas_dedup.latest_ts::date AS financial_institution_date,
  reservas_dedup.unit_name,
  NULLIF(reservas_dedup.unit_id_txt,'')::int AS unit_id,
  NULL::numeric AS land_value,
  (reservas_dedup.titular->>'idpessoa_cv')::int AS customer_id,
  reservas_dedup.titular->>'nome' AS customer_name,
  COALESCE((reservas_dedup.titular->>'porcentagem')::numeric, NULL) AS participation_percentage,
  '[]'::jsonb AS associates,
  COALESCE(reservas_dedup.condicoes, '[]'::jsonb) AS payment_conditions,
  '[]'::jsonb AS links,
  '[]'::jsonb AS repasse,
  to_jsonb(reservas_dedup.*) AS reserva,
  reservas_dedup.erp_city,
  'reserva'::text AS origin
FROM reservas_dedup

ORDER BY financial_institution_date, contract_id NULLS LAST;
`;

    const replacements = {
      start: start.format('YYYY-MM-DD'),
      end: end.format('YYYY-MM-DD'),
      situation: sit,
      isAdmin,
      userCity: userCityRaw,
      groups_json: groupsJson, // null ou JSON string
    };
    nameList.forEach((val, i) => { replacements[`name${i}`] = val; });

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

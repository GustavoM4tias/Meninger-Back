// src/controllers/sienge/contractSalesController.js
import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';
import { enterpriseCityMap } from '../../config/cityMappings.js';

// caches globais
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
      nameList = enterpriseName.map(name => `%${name.trim()}%`);
    } else if (typeof enterpriseName === 'string') {
      nameList = enterpriseName
        .split(',')
        .map(n => n.trim())
        .filter(Boolean)
        .map(name => `%${name}%`);
    }

    const whereNameClause = nameList.length > 0
      ? ` AND (${nameList.map((_, i) => `sc.enterprise_name ILIKE :name${i}`).join(' OR ')})`
      : '';

    // 🔽 Agora tudo vem de contracts + JSONB
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
        THEN replace(regexp_replace(b.land_value::text, '\.', '', 'g'), ',', '.')::numeric
      ELSE
        regexp_replace(b.land_value::text, '[^0-9\.]', '', 'g')::numeric
    END AS land_value,

    -- Unidade principal (preferência main=true; senão, a 1ª)
    COALESCE( 
      (SELECT u ->> 'name'
       FROM jsonb_array_elements(b.units) u
       WHERE (u ->> 'main')::boolean = true
       LIMIT 1),
      (SELECT u ->> 'name'
       FROM jsonb_array_elements(b.units) u
       LIMIT 1)
    ) AS unit_name,

    -- unit_id principal (main=true; senão, a 1ª)
    COALESCE(
      (SELECT NULLIF(u ->> 'id','')::int
       FROM jsonb_array_elements(b.units) u
       WHERE (u ->> 'main')::boolean = true
       LIMIT 1),
      (SELECT NULLIF(u ->> 'id','')::int
       FROM jsonb_array_elements(b.units) u
       LIMIT 1)
    ) AS unit_id,

    -- cliente principal
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

    -- associados: todos os clientes com nome != do titular (por nome normalizado),
    -- cônjuge primeiro; deduplicação por nome normalizado; preferir quem tem participação > 0
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

            -- normaliza nome: remove acentos, pontuação/espacos, e stopwords comuns
            -- 1) maiúsculas sem acento
            unaccent(upper(c ->> 'name'))                                                  AS cname_up,
            -- 2) troca não alfanum por espaço
            regexp_replace(unaccent(upper(c ->> 'name')), '[^A-Z0-9]+', ' ', 'g')          AS cname_spc,
            -- 3) remove stopwords (DE, DA, DO, DAS, DOS, E) como palavras inteiras
            regexp_replace(
              regexp_replace(unaccent(upper(c ->> 'name')), '[^A-Z0-9]+', ' ', 'g'),
              '(^| )(DE|DA|DO|DAS|DOS|E)( |$)', ' ', 'g'
            )                                                                              AS cname_nostop_spc,
            -- 4) tira todos os espaços
            regexp_replace(
              regexp_replace(
                regexp_replace(unaccent(upper(c ->> 'name')), '[^A-Z0-9]+', ' ', 'g'),
                '(^| )(DE|DA|DO|DAS|DOS|E)( |$)', ' ', 'g'
              ),
              '\s+', '', 'g'
            )                                                                              AS cname_norm
          FROM jsonb_array_elements(b.customers) c
        ),
        main_sel AS (
          -- principal por regra atual
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
            )                                                  AS main_id,
            -- nome normalizado do titular (mesmo pipeline)
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
            )                                                  AS main_name_spc,
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
            )                                                  AS main_name_norm
        ),
        picked AS (
          -- tira o titular e eventuais variações do próprio titular (mesmo nome normalizado),
          -- e escolhe 1 por nome (cname_norm) priorizando: (1) cônjuge, (2) participação, (3) ordem
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

    -- Normalizações
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

  -- array de repasses (mesma lógica de escolha)
  COALESCE(rp.repasse, '[]'::jsonb) AS repasse,

  -- json da reserva correspondente ao repasse escolhido (1º elemento da agregação)
  rp.reservas->0 AS reserva

FROM pivots p
LEFT JOIN LATERAL (
  SELECT
    jsonb_agg(to_jsonb(r))                        AS repasse,   -- array (máx. 1 item pelo LIMIT)
    jsonb_agg(DISTINCT to_jsonb(res))             AS reservas   -- agrega para não violar regra do GROUP
  FROM (
    SELECT
      r.*,
      (r.codigointerno_unidade::text = p.unit_id::text) AS id_match,
      COALESCE(r.data_status_repasse, r.data_contrato_liberado, r.data_contrato_contab) AS data_mais_recente
    FROM repasses r
    WHERE
      -- 1) Match por ID
      r.codigointerno_unidade::text = p.unit_id::text
      -- 2) Fallback por nome + enterprise_id
      OR (
        regexp_replace(unaccent(upper(COALESCE(r.unidade, ''))), '[^A-Z0-9]+', '', 'g') = p.unit_name_norm
        AND r.codigointerno_empreendimento::text = p.enterprise_id::text
      )
      -- 3) Fallback por nome + prefixo de company_id
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

ORDER BY p.financial_institution_date, p.contract_id;
`;

    const replacements = {
      start: start.format('YYYY-MM-DD'),
      end: end.format('YYYY-MM-DD'),
      situation: sit
    };
    nameList.forEach((val, i) => { replacements[`name${i}`] = val; });

    let results = await db.sequelize.query(sql, {
      replacements,
      type: db.Sequelize.QueryTypes.SELECT
    });

    // 🔒 Filtro por cidade (se não for admin)
    if (req.user.role !== 'admin') {
      const city = req.user.city;
      results = results.filter(item => enterpriseCityMap[item.enterprise_id] === city);
    }

    return res.json({ count: results.length, results });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao buscar contratos.' });
  }
}

export async function listEnterprises(req, res) {
  if (_enterprisesCache && Date.now() - _enterprisesCacheTs < CACHE_TTL) {
    const cached = req.user.role === 'admin'
      ? _enterprisesCache
      : _enterprisesCache.filter(e => enterpriseCityMap[e.id] === req.user.city);
    return res.json({ count: cached.length, results: cached });
  }

  const rows = await db.SalesContract.findAll({
    attributes: [
      ['enterprise_id', 'id'],
      ['enterprise_name', 'name']
    ],
    group: ['enterprise_id', 'enterprise_name'],
    order: [['enterprise_name', 'ASC']]
  });

  const results = rows.map(e => ({ id: e.get('id'), name: e.get('name') }));
  _enterprisesCache = results;
  _enterprisesCacheTs = Date.now();

  const filtered = req.user.role === 'admin'
    ? results
    : results.filter(e => enterpriseCityMap[e.id] === req.user.city);

  return res.json({ count: filtered.length, results: filtered });
}

export async function clearCache(req, res) {
  _enterprisesCache = null;
  _enterprisesCacheTs = 0;
  return res.json({ message: 'Caches limpos.' });
}

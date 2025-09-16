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
      (SELECT (u ->> 'id')::int
       FROM jsonb_array_elements(b.units) u
       WHERE (u ->> 'main')::boolean = true
       LIMIT 1),
      (SELECT (u ->> 'id')::int
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

    -- associados "main" (exceto o principal)
    COALESCE(
      (
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'customer_id', (c ->> 'id')::int,
                   'name', c ->> 'name',
                   'participation_percentage',
                   NULLIF(c ->> 'participationPercentage', '')::numeric
                 )
        )
        FROM jsonb_array_elements(b.customers) c
        WHERE (c ->> 'main')::boolean = true
          AND (c ->> 'id')::int IS DISTINCT FROM (
            COALESCE(
              (SELECT (mc ->> 'id')::int
               FROM jsonb_array_elements(b.customers) mc
               WHERE (mc ->> 'main')::boolean = true
               LIMIT 1),
              (SELECT (mc ->> 'id')::int
               FROM jsonb_array_elements(b.customers) mc
               ORDER BY (mc ->> 'id')::int NULLS LAST
               LIMIT 1)
            )
          )
      ),
      '[]'::jsonb
    ) AS associates,

    COALESCE(b.payment_conditions, '[]'::jsonb) AS payment_conditions,
    COALESCE(b.links_json, '[]'::jsonb)         AS links,

    -- Normalização para matching por nome da unidade
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

  (p.main_customer ->> 'id')::int                                    AS customer_id,
  (p.main_customer ->> 'name')                                       AS customer_name,
  NULLIF(p.main_customer ->> 'participationPercentage', '')::numeric AS participation_percentage,
  p.associates,
  p.payment_conditions,
  p.links,

  -- repasse escolhido (como antes)
  COALESCE(rp.repasse, '[]'::jsonb) AS repasse,

  -- reserva(s) correspondente(s) ao idreserva do repasse escolhido
  COALESCE(rp.reserva, '[]'::jsonb) AS reserva

FROM pivots p
LEFT JOIN LATERAL (
  SELECT
    jsonb_agg(to_jsonb(rr)) AS repasse,
    (
      SELECT jsonb_agg(to_jsonb(z))
      FROM reservas z
      WHERE z.idreserva = rr.idreserva
    ) AS reserva
  FROM (
    SELECT r.*,
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
  ) rr
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

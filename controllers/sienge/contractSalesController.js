// src/controllers/contractSalesController.js
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
    const start = startDate
      ? dayjs(startDate)
      : today.startOf('month');
    const end = endDate
      ? dayjs(endDate)
      : today;

    const validSituations = ['Emitido', 'Autorizado', 'Cancelado'];
    const sit = validSituations.includes(situation)
      ? situation
      : 'Emitido';

    let nameList = [];

    if (Array.isArray(enterpriseName)) {
      nameList = enterpriseName.map(name => `%${name.trim()}%`);
    } else if (typeof enterpriseName === 'string') {
      // Verifica se é lista separada por vírgula e trata como array
      const splitNames = enterpriseName.split(',').map(n => n.trim()).filter(Boolean);
      nameList = splitNames.map(name => `%${name}%`);
    }
    const whereNameClause = nameList.length > 0
      ? ` AND (${nameList.map((_, i) => `sc.enterprise_name ILIKE :name${i}`).join(' OR ')})`
      : '';

    const sql = `
WITH customers_ranked AS (
  SELECT
    scu.contract_id,
    sc.enterprise_id,
    sc.enterprise_name,
    sc.financial_institution_date,
    scu.name AS unit_name,
    scc.id AS scc_id,
    scc.customer_id,
    scc.name AS customer_name,
    scc.participation_percentage,
    ROW_NUMBER() OVER (
      PARTITION BY scu.contract_id
      ORDER BY scc.id
    ) AS rn
  FROM sales_contract_units scu
  LEFT JOIN sales_contracts sc ON sc.id = scu.contract_id
  LEFT JOIN sales_contract_customers scc ON scc.contract_id = scu.contract_id
  WHERE sc.financial_institution_date BETWEEN :start AND :end
    AND sc.situation = :situation 
    ${whereNameClause}
    AND scc.main = true
  ),  
payment_grouped AS (
  SELECT
    pc.contract_id,
    JSON_AGG(
      JSON_BUILD_OBJECT(
        'condition_type_id', pc.condition_type_id,
        'condition_type_name', pc.condition_type_name,
        'total_value', COALESCE(pc.total_value, 0)
      )
    ) AS payment_conditions
  FROM payment_conditions pc
  GROUP BY pc.contract_id
),
associates_grouped AS (
  SELECT
    scc.contract_id,
    JSON_AGG(
      JSON_BUILD_OBJECT(
        'customer_id', scc.customer_id,
        'name', scc.name,
        'participation_percentage', scc.participation_percentage::numeric
      )
    ) AS associates
  FROM sales_contract_customers scc
  WHERE scc.main = true
    AND scc.id NOT IN (
      SELECT MIN(scc2.id)
      FROM sales_contract_customers scc2
      WHERE scc2.main = true
      GROUP BY scc2.contract_id
    )
  GROUP BY scc.contract_id
),
contract_links_grouped AS (
  SELECT
    cl.contract_id,
    JSON_AGG(
      JSON_BUILD_OBJECT(
        'rel', cl.rel,
        'href', cl.href
      )
    ) AS links
  FROM contract_links cl
  GROUP BY cl.contract_id
)
SELECT
  cr.contract_id,
  cr.enterprise_id,
  cr.enterprise_name,
  cr.financial_institution_date,
  cr.unit_name,
  cr.customer_id,
  cr.customer_name,
  cr.participation_percentage,
  COALESCE(ag.associates, '[]') AS associates,
  COALESCE(pg.payment_conditions, '[]') AS payment_conditions,
  COALESCE(clg.links, '[]') AS links
FROM customers_ranked cr
LEFT JOIN payment_grouped pg ON cr.contract_id = pg.contract_id
LEFT JOIN associates_grouped ag ON cr.contract_id = ag.contract_id
LEFT JOIN contract_links_grouped clg ON cr.contract_id = clg.contract_id
WHERE cr.rn = 1
ORDER BY cr.financial_institution_date, cr.contract_id;
`;

    const replacements = {
      start: start.format('YYYY-MM-DD'),
      end: end.format('YYYY-MM-DD'),
      situation: sit
    };

    nameList.forEach((val, i) => {
      replacements[`name${i}`] = val;
    });

    console.log('[DEBUG] replacements:', replacements);
    console.log('[DEBUG] whereNameClause:', whereNameClause);

    let results = await db.sequelize.query(sql, {
      replacements,
      type: db.Sequelize.QueryTypes.SELECT
    });

    // 🔒 Filtro por cidade (se não for admin)
    if (req.user.role !== 'admin') {
      const city = req.user.city;
      results = results.filter(item => {
        const enterpriseCity = enterpriseCityMap[item.enterprise_id];
        return enterpriseCity === city
      });
    }

    return res.json({ count: results.length, results });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao buscar contratos.' });
  }
}

export async function listEnterprises(req, res) {
  if (_enterprisesCache && Date.now() - _enterprisesCacheTs < CACHE_TTL) {
    let filtered = _enterprisesCache;
    if (req.user.role !== 'admin') {
      filtered = filtered.filter(e => enterpriseCityMap[e.id] === req.user.city);
    }
    return res.json({ count: filtered.length, results: filtered });
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
  _companiesCache = null;
  _enterprisesCache = null;
  return res.json({ message: 'Caches limpos.' });
}

// WITH customers_ranked AS (
//   SELECT
//     scu.contract_id,
//     sc.enterprise_id,
//     sc.enterprise_name,
//     sc.financial_institution_date,
//     scc.id AS customer_id,
//     scc.name AS customer_name,
//     scc.participation_percentage,
//     ROW_NUMBER() OVER (PARTITION BY scu.contract_id ORDER BY scc.id) AS rn
//   FROM sales_contract_units scu
//   LEFT JOIN sales_contracts sc ON sc.id = scu.contract_id
//   LEFT JOIN sales_contract_customers scc ON scc.contract_id = scu.contract_id
//   WHERE sc.financial_institution_date BETWEEN :start AND :end
//     AND sc.situation = :situation
//     AND (:nameFilter IS NULL OR sc.enterprise_name ILIKE :nameFilter)
// ),
// payment_grouped AS (
//   SELECT
//     pc.contract_id,
//     JSON_AGG(
//       JSON_BUILD_OBJECT(
//         'condition_type_id', pc.condition_type_id,
//         'condition_type_name', pc.condition_type_name,
//         'total_value', COALESCE(pc.total_value, 0)
//       )
//     ) AS payment_conditions
//   FROM payment_conditions pc
//   GROUP BY pc.contract_id
// ),
// associates_grouped AS (
//   SELECT
//     scc.contract_id,
//     JSON_AGG(DISTINCT scc.name) AS associates
//   FROM sales_contract_customers scc
//   WHERE scc.id NOT IN (
//     SELECT MIN(scc2.id) FROM sales_contract_customers scc2 GROUP BY scc2.contract_id
//   )
//   GROUP BY scc.contract_id
// )
// SELECT
//   cr.contract_id,
//   cr.enterprise_id,
//   cr.enterprise_name,
//   cr.financial_institution_date,
//   cr.customer_name,
//   cr.participation_percentage,
//   COALESCE(ag.associates, '[]') AS associates,
//   COALESCE(pg.payment_conditions, '[]') AS payment_conditions
// FROM customers_ranked cr
// LEFT JOIN payment_grouped pg ON pg.contract_id = cr.contract_id
// LEFT JOIN associates_grouped ag ON ag.contract_id = cr.contract_id
// WHERE cr.rn = 1
// ORDER BY cr.financial_institution_date, cr.contract_id;
//     `;
// controllers/projectionsController.js
import db from '../models/sequelize/index.js';
import { summarizeUnitsFromDb } from '../services/cv/enterpriseUnitsSummaryService.js';

const {
  SalesProjection,
  SalesProjectionLine,
  SalesProjectionLog,
  SalesProjectionEnterprise,
  EnterpriseCity,
  Sequelize,
  User,
} = db;

const { Op } = Sequelize;

const assertAdmin = (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso negado.' });
  return null;
};

// Normalização de cidade
const CITY_EQ = (col) => `
  unaccent(upper(regexp_replace(${col}, '[^A-Z0-9]+',' ','g')))
`;

const normYM = (v) => {
  const ym = String(v || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error(`year_month inválido: ${v}`);
  return ym;
};

const isTruthy = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';

const getRangeOrNull = (req) => {
  const start = req.query.start_month ? normYM(req.query.start_month) : null;
  const end = req.query.end_month ? normYM(req.query.end_month) : null;
  if ((start && !end) || (!start && end)) throw new Error('Envie start_month e end_month juntos (ou nenhum).');
  if (start && end && start > end) throw new Error('start_month não pode ser maior que end_month');
  return { start, end };
};

/**
 * =============================================================================
 * ✅ VIABILIDADE (CV) — cache global (process-wide) + ENRICH defaults
 * =============================================================================
 * - Injeta em enterprise_defaults:
 *   - cv_enterprise_id
 *   - units_summary { totalUnits, soldUnits, soldUnitsStock, reservedUnits, blockedUnits, availableUnits, availableInventory }
 *
 * - Também registra logs internos (console) quando CV falhar, pra rastrear problemas.
 */
const unitsCache = new Map();
const UNITS_TTL = 30_000;

async function getUnitsSummaryCached(cvEnterpriseId) {
  if (!cvEnterpriseId) return null;

  const key = `units:${cvEnterpriseId}`;
  const now = Date.now();
  const memo = unitsCache.get(key);
  if (memo && now - memo.ts < UNITS_TTL) return memo.data;

  try {
    const data = await summarizeUnitsFromDb(Number(cvEnterpriseId));
    unitsCache.set(key, { ts: now, data });
    return data;
  } catch (e) {
    // log técnico pra investigar falhas de CV sem quebrar a tela
    console.error('[projections][units_summary] erro ao carregar CV snapshot', {
      cvEnterpriseId,
      message: e?.message,
    });
    unitsCache.set(key, { ts: now, data: null });
    return null;
  }
}

async function resolveCvEnterpriseIdByErp({ erpId }) {
  if (!erpId) return undefined;

  const row = await EnterpriseCity.findOne({
    where: { source: 'crm', erp_id: String(erpId) },
    attributes: ['crm_id'],
  });

  if (!row) return undefined;
  return row.crm_id != null ? Number(row.crm_id) : undefined;
}

async function enrichDefaultsWithUnits(defaults) {
  if (!Array.isArray(defaults) || defaults.length === 0) return defaults;

  // dedup ERP->cvId e cvId->summary
  const cvIdByErp = new Map();
  const summaryByCvId = new Map();

  // 1) resolve cvId para cada item
  const itemsWithCv = await Promise.all(
    defaults.map(async (d) => {
      const erpId = d?.erp_id != null ? String(d.erp_id) : null;

      let cvId = d?.cv_enterprise_id != null ? Number(d.cv_enterprise_id) : undefined;

      if (!cvId && erpId) {
        if (cvIdByErp.has(erpId)) {
          cvId = cvIdByErp.get(erpId);
        } else {
          const resolved = await resolveCvEnterpriseIdByErp({ erpId });
          cvIdByErp.set(erpId, resolved);
          cvId = resolved;
        }
      }

      return { d, cvId: cvId ?? null };
    })
  );

  // 2) carrega summaries (dedup por cvId)
  const uniqueCvIds = [...new Set(itemsWithCv.map((x) => x.cvId).filter(Boolean))];

  await Promise.all(
    uniqueCvIds.map(async (cvId) => {
      const summary = await getUnitsSummaryCached(cvId);
      summaryByCvId.set(cvId, summary);
    })
  );

  // 3) injeta no payload (formato que o front já espera no AvailabilityInline)
  return itemsWithCv.map(({ d, cvId }) => {
    const unitsSummary = cvId ? summaryByCvId.get(cvId) : null;

    return {
      ...d,
      cv_enterprise_id: cvId,
      units_summary: unitsSummary
        ? {
          totalUnits: unitsSummary.totalUnits,
          soldUnits: unitsSummary.soldUnits,
          soldUnitsStock: unitsSummary.soldUnitsStock ?? unitsSummary.soldUnits ?? 0,
          reservedUnits: unitsSummary.reservedUnits,
          blockedUnits: unitsSummary.blockedUnits,
          availableUnits: unitsSummary.availableUnits,
          availableInventory: unitsSummary.availableInventory,
        }
        : null,
    };
  });
}

/**
 * =============================================================================
 * SQL: Allowed (USER)
 * =============================================================================
 */
const SQL_ALLOWED = `
WITH allowed AS (
  SELECT DISTINCT ec.erp_id
  FROM enterprise_cities ec
  WHERE ec.erp_id IS NOT NULL
    AND ${CITY_EQ(`COALESCE(ec.city_override, ec.default_city)`)} = ${CITY_EQ(`:userCity`)}
)
`;

/**
 * =============================================================================
 * MV: include_zero=1 precisa incluir:
 *  - pares vindos de QUALQUER line existente (mesmo units=0) OU defaults
 *  - e trazer as lines no range (ou todas se sem range)
 *
 * include_zero=0:
 *  - pares pelo "range real" calculado em lines com units_target>0
 */

/* ===========================
   ADMIN — include_zero=0 (range real)
=========================== */
const SQL_ADMIN_PAIRS_RANGE_REAL = `
WITH pairs_in_view AS (
  SELECT DISTINCT
    l.enterprise_key,
    COALESCE(l.alias_id,'default') AS alias_id
  FROM sales_projection_lines l
  WHERE l.projection_id = :pid
    AND EXISTS (
      SELECT 1
      FROM sales_projection_lines x
      WHERE x.projection_id = :pid
        AND x.enterprise_key = l.enterprise_key
        AND COALESCE(x.alias_id,'default') = COALESCE(l.alias_id,'default')
        AND x.year_month BETWEEN :start AND :end
        AND COALESCE(x.units_target,0) > 0
    )
)
SELECT
  p.enterprise_key,
  p.alias_id,
  d.erp_id,
  d.enterprise_name_cache,
  COALESCE(d.default_avg_price,0) AS default_avg_price,
  COALESCE(d.default_marketing_pct,0) AS default_marketing_pct,
  COALESCE(d.default_commission_pct,0) AS default_commission_pct,
  d.total_units
FROM pairs_in_view p
LEFT JOIN sales_projection_enterprises d
  ON d.projection_id = :pid
 AND d.enterprise_key = p.enterprise_key
 AND COALESCE(d.alias_id,'default') = p.alias_id
ORDER BY p.enterprise_key ASC, p.alias_id ASC;
`;

const SQL_ADMIN_LINES_RANGE = `
SELECT
  l.id, l.enterprise_key, l.erp_id, l.alias_id, l.year_month,
  l.units_target, l.avg_price_target,
  l.enterprise_name_cache, l.created_at, l.updated_at,
  l.marketing_pct, l.commission_pct
FROM sales_projection_lines l
WHERE l.projection_id = :pid
  AND l.year_month BETWEEN :start AND :end
ORDER BY l.enterprise_key ASC, COALESCE(l.alias_id,'default') ASC, l.year_month ASC;
`;

/* ===========================
   ADMIN — include_zero=1 (pairs ANY: lines UNION defaults)
=========================== */
const SQL_ADMIN_PAIRS_ANY = `
WITH pairs AS (
  -- ✅ qualquer line existente (independente de units_target)
  SELECT
    l.enterprise_key,
    COALESCE(l.alias_id,'default') AS alias_id,
    MAX(l.erp_id) AS erp_id,
    MAX(l.enterprise_name_cache) AS enterprise_name_cache
  FROM sales_projection_lines l
  WHERE l.projection_id = :pid
  GROUP BY l.enterprise_key, COALESCE(l.alias_id,'default')

  UNION

  -- ✅ qualquer default existente
  SELECT
    d.enterprise_key,
    COALESCE(d.alias_id,'default') AS alias_id,
    d.erp_id,
    d.enterprise_name_cache
  FROM sales_projection_enterprises d
  WHERE d.projection_id = :pid
)
SELECT
  p.enterprise_key,
  p.alias_id,
  COALESCE(d.erp_id, p.erp_id) AS erp_id,
  COALESCE(d.enterprise_name_cache, p.enterprise_name_cache) AS enterprise_name_cache,
  COALESCE(d.default_avg_price,0) AS default_avg_price,
  COALESCE(d.default_marketing_pct,0) AS default_marketing_pct,
  COALESCE(d.default_commission_pct,0) AS default_commission_pct,
  d.total_units
FROM pairs p
LEFT JOIN sales_projection_enterprises d
  ON d.projection_id = :pid
 AND d.enterprise_key = p.enterprise_key
 AND COALESCE(d.alias_id,'default') = p.alias_id
ORDER BY p.enterprise_key ASC, p.alias_id ASC;
`;

/* ===========================
   USER — include_zero=0 (range real, allowed)
=========================== */
const SQL_USER_PAIRS_RANGE_REAL = `
${SQL_ALLOWED}
, pairs_in_view AS (
  SELECT DISTINCT
    l.enterprise_key,
    COALESCE(l.alias_id,'default') AS alias_id,
    l.erp_id
  FROM sales_projection_lines l
  JOIN allowed a ON a.erp_id = l.erp_id
  WHERE l.projection_id = :pid
    AND l.erp_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM sales_projection_lines x
      WHERE x.projection_id = :pid
        AND x.erp_id = l.erp_id
        AND x.enterprise_key = l.enterprise_key
        AND COALESCE(x.alias_id,'default') = COALESCE(l.alias_id,'default')
        AND x.year_month BETWEEN :start AND :end
        AND COALESCE(x.units_target,0) > 0
    )
)
SELECT
  p.enterprise_key,
  p.alias_id,
  p.erp_id,
  d.enterprise_name_cache,
  COALESCE(d.default_avg_price,0) AS default_avg_price,
  COALESCE(d.default_marketing_pct,0) AS default_marketing_pct,
  COALESCE(d.default_commission_pct,0) AS default_commission_pct,
  d.total_units
FROM pairs_in_view p
LEFT JOIN sales_projection_enterprises d
  ON d.projection_id = :pid
 AND d.enterprise_key = p.enterprise_key
 AND COALESCE(d.alias_id,'default') = p.alias_id
 AND d.erp_id = p.erp_id
ORDER BY p.enterprise_key ASC, p.alias_id ASC;
`;

const SQL_USER_LINES_RANGE = `
${SQL_ALLOWED}
SELECT
  l.id, l.enterprise_key, l.erp_id, l.alias_id, l.year_month,
  l.units_target, l.avg_price_target,
  l.enterprise_name_cache, l.created_at, l.updated_at,
  l.marketing_pct, l.commission_pct
FROM sales_projection_lines l
JOIN allowed a ON a.erp_id = l.erp_id
WHERE l.projection_id = :pid
  AND l.erp_id IS NOT NULL
  AND l.year_month BETWEEN :start AND :end
ORDER BY l.enterprise_key ASC, COALESCE(l.alias_id,'default') ASC, l.year_month ASC;
`;

/* ===========================
   USER — include_zero=1 (pairs ANY allowed: lines UNION defaults)
=========================== */
const SQL_USER_PAIRS_ANY_ALLOWED = `
${SQL_ALLOWED}
, pairs AS (
  -- ✅ qualquer line existente (independente de units_target), mas só allowed
  SELECT
    l.enterprise_key,
    COALESCE(l.alias_id,'default') AS alias_id,
    l.erp_id,
    MAX(l.enterprise_name_cache) AS enterprise_name_cache
  FROM sales_projection_lines l
  JOIN allowed a ON a.erp_id = l.erp_id
  WHERE l.projection_id = :pid
    AND l.erp_id IS NOT NULL
  GROUP BY l.enterprise_key, COALESCE(l.alias_id,'default'), l.erp_id

  UNION

  -- ✅ defaults existentes, só allowed
  SELECT
    d.enterprise_key,
    COALESCE(d.alias_id,'default') AS alias_id,
    d.erp_id,
    d.enterprise_name_cache
  FROM sales_projection_enterprises d
  JOIN allowed a ON a.erp_id = d.erp_id
  WHERE d.projection_id = :pid
    AND d.erp_id IS NOT NULL
)
SELECT
  p.enterprise_key,
  p.alias_id,
  p.erp_id,
  COALESCE(d.enterprise_name_cache, p.enterprise_name_cache) AS enterprise_name_cache,
  COALESCE(d.default_avg_price,0) AS default_avg_price,
  COALESCE(d.default_marketing_pct,0) AS default_marketing_pct,
  COALESCE(d.default_commission_pct,0) AS default_commission_pct,
  d.total_units
FROM pairs p
LEFT JOIN sales_projection_enterprises d
  ON d.projection_id = :pid
 AND d.enterprise_key = p.enterprise_key
 AND COALESCE(d.alias_id,'default') = p.alias_id
 AND d.erp_id = p.erp_id
ORDER BY p.enterprise_key ASC, p.alias_id ASC;
`;

/**
 * =============================================================================
 * LIST PROJECTIONS
 * =============================================================================
 */
// GET /api/projections?only_active=1
export async function listProjections(req, res) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });

    const { only_active } = req.query;
    const isAdmin = req.user.role === 'admin';
    const userCity = (req.user.city || '').trim();

    if (isAdmin) {
      const where = {};
      if (only_active) where.is_active = true;

      const rows = await SalesProjection.findAll({
        where,
        attributes: ['id', 'name', 'is_locked', 'is_active', 'created_at', 'updated_at'],
        order: [['is_active', 'DESC'], ['updated_at', 'DESC'], ['name', 'ASC']],
      });
      return res.json(rows);
    }

    if (!userCity) return res.status(400).json({ error: 'Cidade do usuário ausente no token.' });

    const sql = `
      ${SQL_ALLOWED}
      , visible AS (
        SELECT DISTINCT l.projection_id
        FROM sales_projection_lines l
        JOIN allowed a ON a.erp_id = l.erp_id
        WHERE l.erp_id IS NOT NULL

        UNION

        SELECT DISTINCT d.projection_id
        FROM sales_projection_enterprises d
        JOIN allowed a ON a.erp_id = d.erp_id
        WHERE d.erp_id IS NOT NULL
      )
      SELECT sp.id, sp.name, sp.is_locked, sp.is_active, sp.created_at, sp.updated_at
      FROM sales_projections sp
      JOIN visible v ON v.projection_id = sp.id
      ${only_active ? 'WHERE sp.is_active = true' : ''}
      ORDER BY sp.is_active DESC, sp.updated_at DESC, sp.name ASC;
    `;

    const rows = await db.sequelize.query(sql, {
      replacements: { userCity },
      type: db.Sequelize.QueryTypes.SELECT,
    });

    return res.json(rows);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Erro ao listar projeções.' });
  }
}

/**
 * =============================================================================
 * CREATE PROJECTION (ADMIN)
 * =============================================================================
 */
export async function createProjection(req, res) {
  const deny = assertAdmin(req, res);
  if (deny) return;

  const trx = await db.sequelize.transaction();
  try {
    const { name, is_active } = req.body;
    if (!name) {
      await trx.rollback();
      return res.status(400).json({ error: 'Informe name.' });
    }

    const created = await SalesProjection.create(
      { name: String(name), is_locked: false, is_active: !!is_active, created_by: req.user.id },
      { transaction: trx }
    );

    if (created.is_active) {
      await SalesProjection.update(
        { is_active: false },
        { where: { id: { [Op.ne]: created.id } }, transaction: trx }
      );
    }

    await SalesProjectionLog.create(
      {
        projection_id: created.id,
        action: 'CREATED',
        user_id: req.user.id,
        payload_after: { id: created.id, name: created.name, is_active: created.is_active },
      },
      { transaction: trx }
    );

    await trx.commit();
    return res.status(201).json({
      id: created.id,
      name: created.name,
      is_locked: created.is_locked,
      is_active: created.is_active,
      created_at: created.created_at,
      updated_at: created.updated_at,
    });
  } catch (e) {
    console.error(e);
    await trx.rollback();
    return res.status(500).json({ error: e.message || 'Erro ao criar projeção.' });
  }
}

/**
 * =============================================================================
 * CLONE PROJECTION (ADMIN)
 * =============================================================================
 */
export async function cloneProjection(req, res) {
  const deny = assertAdmin(req, res);
  if (deny) return;

  const trx = await db.sequelize.transaction();
  try {
    const { source_id, name, is_active } = req.body;
    if (!source_id || !name) {
      await trx.rollback();
      return res.status(400).json({ error: 'Informe source_id e name.' });
    }

    const source = await SalesProjection.findByPk(Number(source_id), { transaction: trx });
    if (!source) {
      await trx.rollback();
      return res.status(400).json({ error: 'Projeção de origem inválida.' });
    }

    const created = await SalesProjection.create(
      { name: String(name), is_locked: false, is_active: !!is_active, created_by: req.user.id },
      { transaction: trx }
    );

    const srcDefaults = await SalesProjectionEnterprise.findAll({ where: { projection_id: source.id }, transaction: trx });
    if (srcDefaults.length) {
      await SalesProjectionEnterprise.bulkCreate(
        srcDefaults.map((d) => ({
          projection_id: created.id,
          enterprise_key: d.enterprise_key,
          erp_id: d.erp_id ?? null,
          alias_id: d.alias_id || 'default',
          default_avg_price: Number(d.default_avg_price || 0),
          enterprise_name_cache: d.enterprise_name_cache || null,
          default_marketing_pct: Number(d.default_marketing_pct || 0),
          default_commission_pct: Number(d.default_commission_pct || 0),
          total_units: d.total_units ?? null,
        })),
        { transaction: trx }
      );
    }

    const srcLines = await SalesProjectionLine.findAll({ where: { projection_id: source.id }, transaction: trx });
    if (srcLines.length) {
      await SalesProjectionLine.bulkCreate(
        srcLines.map((l) => ({
          projection_id: created.id,
          enterprise_key: l.enterprise_key,
          erp_id: l.erp_id ?? null,
          alias_id: l.alias_id || 'default',
          year_month: l.year_month,
          units_target: Number(l.units_target || 0),
          avg_price_target: Number(l.avg_price_target || 0),
          enterprise_name_cache: l.enterprise_name_cache || null,
          marketing_pct: Number(l.marketing_pct || 0),
          commission_pct: Number(l.commission_pct || 0),
        })),
        { transaction: trx }
      );
    }

    if (created.is_active) {
      await SalesProjection.update(
        { is_active: false },
        { where: { id: { [Op.ne]: created.id } }, transaction: trx }
      );
    }

    await SalesProjectionLog.create(
      {
        projection_id: created.id,
        action: 'CLONED',
        user_id: req.user.id,
        payload_after: {
          from: source.id,
          new_id: created.id,
          copied_defaults: srcDefaults.length,
          copied_lines: srcLines.length,
          is_active: created.is_active,
        },
      },
      { transaction: trx }
    );

    await trx.commit();
    return res.status(201).json({
      id: created.id,
      name: created.name,
      is_locked: created.is_locked,
      is_active: created.is_active,
    });
  } catch (e) {
    console.error(e);
    await trx.rollback();
    return res.status(400).json({ error: e.message || 'Erro ao clonar projeção.' });
  }
}

/**
 * =============================================================================
 * GET PROJECTION DETAIL (MV)
 * =============================================================================
 * GET /api/projections/:id?start_month=YYYY-MM&end_month=YYYY-MM&include_zero=1
 *
 * ✅ Agora SEMPRE retorna enterprise_defaults enriquecido com:
 *    - cv_enterprise_id
 *    - units_summary (snapshot CV)
 *
 * ✅ Acompanhamento de logs:
 *    - Registra um log leve de VIEW_DETAIL (sem payload gigante), pra rastrear “possíveis problemas”
 */
export async function getProjectionDetail(req, res) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido.' });

    const proj = await SalesProjection.findByPk(id, {
      attributes: ['id', 'name', 'is_locked', 'is_active', 'created_at', 'updated_at'],
    });
    if (!proj) return res.status(404).json({ error: 'Projeção não encontrada.' });

    const isAdmin = req.user.role === 'admin';
    const includeZero = isTruthy(req.query.include_zero);
    const { start, end } = getRangeOrNull(req);
    const hasRange = !!(start && end);

    // =========================
    // ADMIN
    // =========================
    if (isAdmin) {
      // include_zero=1
      if (includeZero) {
        const defaults = await db.sequelize.query(SQL_ADMIN_PAIRS_ANY, {
          replacements: { pid: id },
          type: db.Sequelize.QueryTypes.SELECT,
        });

        const lines = hasRange
          ? await db.sequelize.query(SQL_ADMIN_LINES_RANGE, {
            replacements: { pid: id, start, end },
            type: db.Sequelize.QueryTypes.SELECT,
          })
          : await SalesProjectionLine.findAll({
            where: { projection_id: id },
            attributes: [
              'id',
              'enterprise_key',
              'erp_id',
              'alias_id',
              'year_month',
              'units_target',
              'avg_price_target',
              'enterprise_name_cache',
              'created_at',
              'updated_at',
              'marketing_pct',
              'commission_pct',
            ],
            order: [['enterprise_key', 'ASC'], ['alias_id', 'ASC'], ['year_month', 'ASC']],
          });

        const defaultsEnriched = await enrichDefaultsWithUnits(defaults);

        // log leve de acompanhamento
        try {
          await SalesProjectionLog.create({
            projection_id: id,
            action: 'VIEW_DETAIL',
            user_id: req.user.id,
            payload_after: {
              include_zero: true,
              start_month: start ?? null,
              end_month: end ?? null,
              lines_count: Array.isArray(lines) ? lines.length : (lines?.length ?? null),
              defaults_count: defaultsEnriched?.length ?? 0,
            },
            note: `Detalhe carregado (admin, include_zero=sim${hasRange ? `, range=${start}..${end}` : ''}).`,
          });
        } catch (e) {
          console.error('[projections][VIEW_DETAIL] falha ao salvar log', e?.message);
        }

        return res.json({ projection: proj, lines, enterprise_defaults: defaultsEnriched });
      }

      // include_zero=0 (sem range)
      if (!hasRange) {
        const lines = await SalesProjectionLine.findAll({
          where: { projection_id: id },
          attributes: [
            'id',
            'enterprise_key',
            'erp_id',
            'alias_id',
            'year_month',
            'units_target',
            'avg_price_target',
            'enterprise_name_cache',
            'created_at',
            'updated_at',
            'marketing_pct',
            'commission_pct',
          ],
          order: [['enterprise_key', 'ASC'], ['alias_id', 'ASC'], ['year_month', 'ASC']],
        });

        const defaults = await SalesProjectionEnterprise.findAll({
          where: { projection_id: id },
          attributes: [
            'enterprise_key',
            'erp_id',
            'alias_id',
            'default_avg_price',
            'enterprise_name_cache',
            'default_marketing_pct',
            'default_commission_pct',
            'total_units',
          ],
          order: [['enterprise_key', 'ASC'], ['alias_id', 'ASC']],
        });

        const defaultsPlain = defaults.map((d) => (d?.toJSON ? d.toJSON() : d));
        const defaultsEnriched = await enrichDefaultsWithUnits(defaultsPlain);

        try {
          await SalesProjectionLog.create({
            projection_id: id,
            action: 'VIEW_DETAIL',
            user_id: req.user.id,
            payload_after: {
              include_zero: false,
              start_month: null,
              end_month: null,
              lines_count: lines?.length ?? 0,
              defaults_count: defaultsEnriched?.length ?? 0,
            },
            note: 'Detalhe carregado (admin, include_zero=não, sem range).',
          });
        } catch (e) {
          console.error('[projections][VIEW_DETAIL] falha ao salvar log', e?.message);
        }

        return res.json({ projection: proj, lines, enterprise_defaults: defaultsEnriched });
      }

      // include_zero=0 com range (range real)
      const defaults = await db.sequelize.query(SQL_ADMIN_PAIRS_RANGE_REAL, {
        replacements: { pid: id, start, end },
        type: db.Sequelize.QueryTypes.SELECT,
      });

      const lines = await db.sequelize.query(SQL_ADMIN_LINES_RANGE, {
        replacements: { pid: id, start, end },
        type: db.Sequelize.QueryTypes.SELECT,
      });

      const defaultsEnriched = await enrichDefaultsWithUnits(defaults);

      try {
        await SalesProjectionLog.create({
          projection_id: id,
          action: 'VIEW_DETAIL',
          user_id: req.user.id,
          payload_after: {
            include_zero: false,
            start_month: start,
            end_month: end,
            lines_count: lines?.length ?? 0,
            defaults_count: defaultsEnriched?.length ?? 0,
          },
          note: `Detalhe carregado (admin, include_zero=não, range=${start}..${end}).`,
        });
      } catch (e) {
        console.error('[projections][VIEW_DETAIL] falha ao salvar log', e?.message);
      }

      return res.json({ projection: proj, lines, enterprise_defaults: defaultsEnriched });
    }

    // =========================
    // USER
    // =========================
    const userCity = (req.user.city || '').trim();
    if (!userCity) return res.status(400).json({ error: 'Cidade do usuário ausente no token.' });

    if (includeZero) {
      const defaults = await db.sequelize.query(SQL_USER_PAIRS_ANY_ALLOWED, {
        replacements: { pid: id, userCity },
        type: db.Sequelize.QueryTypes.SELECT,
      });

      const lines = hasRange
        ? await db.sequelize.query(SQL_USER_LINES_RANGE, {
          replacements: { pid: id, userCity, start, end },
          type: db.Sequelize.QueryTypes.SELECT,
        })
        : await db.sequelize.query(
          `${SQL_ALLOWED}
             SELECT
               l.id, l.enterprise_key, l.erp_id, l.alias_id, l.year_month,
               l.units_target, l.avg_price_target,
               l.enterprise_name_cache, l.created_at, l.updated_at,
               l.marketing_pct, l.commission_pct
             FROM sales_projection_lines l
             JOIN allowed a ON a.erp_id = l.erp_id
             WHERE l.projection_id = :pid
               AND l.erp_id IS NOT NULL
             ORDER BY l.enterprise_key ASC, COALESCE(l.alias_id,'default') ASC, l.year_month ASC;`,
          { replacements: { pid: id, userCity }, type: db.Sequelize.QueryTypes.SELECT }
        );

      const defaultsEnriched = await enrichDefaultsWithUnits(defaults);

      // log leve (usuário também) — ajuda a rastrear tela “vazia”
      try {
        await SalesProjectionLog.create({
          projection_id: id,
          action: 'VIEW_DETAIL',
          user_id: req.user.id,
          payload_after: {
            include_zero: true,
            start_month: start ?? null,
            end_month: end ?? null,
            lines_count: lines?.length ?? 0,
            defaults_count: defaultsEnriched?.length ?? 0,
          },
          note: `Detalhe carregado (user, include_zero=sim${hasRange ? `, range=${start}..${end}` : ''}).`,
        });
      } catch (e) {
        console.error('[projections][VIEW_DETAIL] falha ao salvar log', e?.message);
      }

      return res.json({ projection: proj, lines, enterprise_defaults: defaultsEnriched });
    }

    // include_zero=0
    if (!hasRange) {
      const lines = await db.sequelize.query(
        `${SQL_ALLOWED}
         SELECT
           l.id, l.enterprise_key, l.erp_id, l.alias_id, l.year_month,
           l.units_target, l.avg_price_target,
           l.enterprise_name_cache, l.created_at, l.updated_at,
           l.marketing_pct, l.commission_pct
         FROM sales_projection_lines l
         JOIN allowed a ON a.erp_id = l.erp_id
         WHERE l.projection_id = :pid
           AND l.erp_id IS NOT NULL
         ORDER BY l.enterprise_key ASC, COALESCE(l.alias_id,'default') ASC, l.year_month ASC;`,
        { replacements: { pid: id, userCity }, type: db.Sequelize.QueryTypes.SELECT }
      );

      const defaults = await db.sequelize.query(
        `${SQL_ALLOWED}
         SELECT
           d.enterprise_key, d.erp_id, d.alias_id,
           d.default_avg_price, d.enterprise_name_cache,
           d.default_marketing_pct, d.default_commission_pct,
           d.total_units
         FROM sales_projection_enterprises d
         JOIN allowed a ON a.erp_id = d.erp_id
         WHERE d.projection_id = :pid
           AND d.erp_id IS NOT NULL
         ORDER BY d.enterprise_key ASC, COALESCE(d.alias_id,'default') ASC;`,
        { replacements: { pid: id, userCity }, type: db.Sequelize.QueryTypes.SELECT }
      );

      const defaultsEnriched = await enrichDefaultsWithUnits(defaults);

      try {
        await SalesProjectionLog.create({
          projection_id: id,
          action: 'VIEW_DETAIL',
          user_id: req.user.id,
          payload_after: {
            include_zero: false,
            start_month: null,
            end_month: null,
            lines_count: lines?.length ?? 0,
            defaults_count: defaultsEnriched?.length ?? 0,
          },
          note: 'Detalhe carregado (user, include_zero=não, sem range).',
        });
      } catch (e) {
        console.error('[projections][VIEW_DETAIL] falha ao salvar log', e?.message);
      }

      return res.json({ projection: proj, lines, enterprise_defaults: defaultsEnriched });
    }

    const defaults = await db.sequelize.query(SQL_USER_PAIRS_RANGE_REAL, {
      replacements: { pid: id, userCity, start, end },
      type: db.Sequelize.QueryTypes.SELECT,
    });

    const lines = await db.sequelize.query(SQL_USER_LINES_RANGE, {
      replacements: { pid: id, userCity, start, end },
      type: db.Sequelize.QueryTypes.SELECT,
    });

    const defaultsEnriched = await enrichDefaultsWithUnits(defaults);

    try {
      await SalesProjectionLog.create({
        projection_id: id,
        action: 'VIEW_DETAIL',
        user_id: req.user.id,
        payload_after: {
          include_zero: false,
          start_month: start,
          end_month: end,
          lines_count: lines?.length ?? 0,
          defaults_count: defaultsEnriched?.length ?? 0,
        },
        note: `Detalhe carregado (user, include_zero=não, range=${start}..${end}).`,
      });
    } catch (e) {
      console.error('[projections][VIEW_DETAIL] falha ao salvar log', e?.message);
    }

    return res.json({ projection: proj, lines, enterprise_defaults: defaultsEnriched });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Erro ao carregar projeção.' });
  }
}

/**
 * =============================================================================
 * UPSERT LINES (ADMIN) — MV
 * =============================================================================
 */
export async function upsertProjectionLines(req, res) {
  const deny = assertAdmin(req, res);
  if (deny) return;

  const trx = await db.sequelize.transaction();
  try {
    const id = Number(req.params.id);
    let { rows, remove_missing } = req.body;
    remove_missing = !!remove_missing;

    const proj = await SalesProjection.findByPk(id, { transaction: trx });
    if (!proj) {
      await trx.rollback();
      return res.status(404).json({ error: 'Projeção não encontrada.' });
    }
    if (proj.is_locked) {
      await trx.rollback();
      return res.status(423).json({ error: 'Projeção bloqueada.' });
    }

    if (!Array.isArray(rows) || !rows.length) {
      await trx.rollback();
      return res.status(400).json({ error: 'Envie rows com pelo menos um item.' });
    }

    const key = (r) => `${id}|${String(r.enterprise_key)}|${String(r.alias_id || 'default')}|${normYM(r.year_month)}`;
    const map = new Map();

    for (const r of rows) {
      const ym = normYM(r.year_month);
      const enterprise_key = String(r.enterprise_key || '').trim();
      if (!enterprise_key) throw new Error('enterprise_key é obrigatório.');

      const alias_id = r.alias_id ? String(r.alias_id) : 'default';
      const erp_id = r.erp_id ? String(r.erp_id) : null;
      const nameCache = r.enterprise_name_cache ? String(r.enterprise_name_cache) : null;

      if (!erp_id && !nameCache) throw new Error(`Linha manual precisa enterprise_name_cache (${enterprise_key}).`);

      map.set(key({ ...r, alias_id, year_month: ym }), {
        projection_id: id,
        enterprise_key,
        erp_id,
        alias_id,
        year_month: ym,
        units_target: Math.max(0, parseInt(r.units_target ?? 0, 10)),
        avg_price_target: Number(r.avg_price_target ?? 0),
        enterprise_name_cache: nameCache,
        marketing_pct: Number(r.marketing_pct ?? 0),
        commission_pct: Number(r.commission_pct ?? 0),
      });
    }

    const normalized = [...map.values()];

    await SalesProjectionLine.bulkCreate(normalized, {
      transaction: trx,
      updateOnDuplicate: [
        'erp_id',
        'units_target',
        'avg_price_target',
        'enterprise_name_cache',
        'marketing_pct',
        'commission_pct',
        'updated_at',
      ],
    });

    if (remove_missing) {
      const keepPairs = new Set(normalized.map((n) => `${n.enterprise_key}|${n.alias_id}`));
      const existing = await SalesProjectionLine.findAll({ where: { projection_id: id }, transaction: trx });

      const toDelete = existing.filter((r) => !keepPairs.has(`${r.enterprise_key}|${r.alias_id || 'default'}`));
      if (toDelete.length) {
        await SalesProjectionLine.destroy({ where: { id: toDelete.map((r) => r.id) }, transaction: trx });
      }
    }

    await SalesProjectionLog.create(
      {
        projection_id: id,
        action: 'UPSERT_LINES',
        user_id: req.user.id,
        payload_after: { count: normalized.length, remove_missing },
        note: `Linhas: upsert ${normalized.length} (remove_missing=${remove_missing ? 'sim' : 'não'}).`,
      },
      { transaction: trx }
    );

    await trx.commit();
    return res.json({ ok: true, upserted: normalized.length });
  } catch (e) {
    console.error(e);
    await trx.rollback();
    return res.status(400).json({ error: e.message || 'Erro ao salvar linhas.' });
  }
}

/**
 * =============================================================================
 * UPSERT DEFAULTS (ADMIN) — MV
 * =============================================================================
 */
export async function upsertProjectionDefaults(req, res) {
  const deny = assertAdmin(req, res);
  if (deny) return;

  const trx = await db.sequelize.transaction();
  try {
    const id = Number(req.params.id);
    let { items, remove_missing } = req.body;
    remove_missing = !!remove_missing;

    if (!Array.isArray(items) || !items.length) {
      await trx.rollback();
      return res.status(400).json({ error: 'Envie items com pelo menos um item.' });
    }

    const key = (r) => `${r.enterprise_key}|${r.alias_id}`;
    const dedup = new Map();

    for (const i of items) {
      const enterprise_key = String(i.enterprise_key || '').trim();
      if (!enterprise_key) throw new Error('enterprise_key é obrigatório nos defaults.');

      const erp_id = i.erp_id ? String(i.erp_id) : null;
      const alias_id = i.alias_id ? String(i.alias_id) : 'default';

      let total_units = null;
      if (typeof i.total_units !== 'undefined' && i.total_units !== null) {
        total_units = Math.max(0, parseInt(i.total_units, 10) || 0);
      } else if (typeof i.totalUnits !== 'undefined' && i.totalUnits !== null) {
        total_units = Math.max(0, parseInt(i.totalUnits, 10) || 0);
      }

      dedup.set(key({ enterprise_key, alias_id }), {
        projection_id: id,
        enterprise_key,
        erp_id,
        alias_id,
        default_avg_price: Number(i.default_avg_price ?? i.defaultPrice ?? 0),
        enterprise_name_cache: i.enterprise_name_cache ?? i.name ?? null,
        default_marketing_pct: Number(i.default_marketing_pct ?? 0),
        default_commission_pct: Number(i.default_commission_pct ?? 0),
        total_units,
      });
    }

    const finalItems = [...dedup.values()];

    await SalesProjectionEnterprise.bulkCreate(finalItems, {
      transaction: trx,
      updateOnDuplicate: [
        'erp_id',
        'default_avg_price',
        'enterprise_name_cache',
        'default_marketing_pct',
        'default_commission_pct',
        'total_units',
        'updated_at',
      ],
    });

    if (remove_missing) {
      const incomingKeys = new Set(finalItems.map((r) => key(r)));
      const before = await SalesProjectionEnterprise.findAll({ where: { projection_id: id }, transaction: trx });
      const toRemove = before.filter(
        (r) => !incomingKeys.has(key({ enterprise_key: r.enterprise_key, alias_id: r.alias_id || 'default' }))
      );
      if (toRemove.length) {
        await SalesProjectionEnterprise.destroy({ where: { id: toRemove.map((r) => r.id) }, transaction: trx });
      }
    }

    await SalesProjectionLog.create(
      {
        projection_id: id,
        action: 'UPSERT_DEFAULTS',
        user_id: req.user.id,
        payload_after: { count: finalItems.length, remove_missing },
        note: `Defaults: upsert ${finalItems.length} (remove_missing=${remove_missing ? 'sim' : 'não'}).`,
      },
      { transaction: trx }
    );

    await trx.commit();
    return res.json({ ok: true, upserted: finalItems.length });
  } catch (e) {
    console.error(e);
    await trx.rollback();
    return res.status(400).json({ error: e.message || 'Erro ao salvar defaults.' });
  }
}

/**
 * =============================================================================
 * UPDATE META (ADMIN)
 * =============================================================================
 */
export async function updateProjectionMeta(req, res) {
  const deny = assertAdmin(req, res);
  if (deny) return;

  const trx = await db.sequelize.transaction();
  try {
    const id = Number(req.params.id);
    const { name, is_locked, is_active } = req.body;

    const proj = await SalesProjection.findByPk(id, { transaction: trx });
    if (!proj) {
      await trx.rollback();
      return res.status(404).json({ error: 'Projeção não encontrada.' });
    }

    const before = proj.toJSON();
    const changes = {};

    if (typeof name !== 'undefined' && String(name) !== proj.name) {
      changes.name = { from: proj.name, to: String(name) };
      proj.name = String(name);
    }
    if (typeof is_locked !== 'undefined' && !!is_locked !== !!proj.is_locked) {
      changes.is_locked = { from: !!proj.is_locked, to: !!is_locked };
      proj.is_locked = !!is_locked;
    }
    if (typeof is_active !== 'undefined' && !!is_active !== !!proj.is_active) {
      changes.is_active = { from: !!proj.is_active, to: !!is_active };
      proj.is_active = !!is_active;
    }

    await proj.save({ transaction: trx });

    if (typeof is_active !== 'undefined' && proj.is_active) {
      await SalesProjection.update(
        { is_active: false },
        { where: { id: { [Op.ne]: proj.id } }, transaction: trx }
      );
    }

    const parts = [];
    if (changes.name) parts.push(`nome: "${changes.name.from}" → "${changes.name.to}"`);
    if (changes.is_locked)
      parts.push(
        `status: ${changes.is_locked.from ? 'Bloqueada' : 'Aberta'} → ${changes.is_locked.to ? 'Bloqueada' : 'Aberta'
        }`
      );
    if (changes.is_active)
      parts.push(`ativa: ${changes.is_active.from ? 'Sim' : 'Não'} → ${changes.is_active.to ? 'Sim' : 'Não'}`);

    const note = parts.length ? `Meta alterada: ${parts.join(' • ')}.` : 'Meta: nenhuma alteração.';

    await SalesProjectionLog.create(
      {
        projection_id: id,
        action:
          typeof is_locked !== 'undefined'
            ? proj.is_locked
              ? 'LOCKED'
              : 'UNLOCKED'
            : typeof is_active !== 'undefined'
              ? proj.is_active
                ? 'ACTIVATED'
                : 'DEACTIVATED'
              : 'UPDATED_META',
        user_id: req.user.id,
        payload_before: before,
        payload_after: proj.toJSON(),
        note,
      },
      { transaction: trx }
    );

    await trx.commit();
    return res.json({ id: proj.id, name: proj.name, is_locked: proj.is_locked, is_active: proj.is_active });
  } catch (e) {
    console.error(e);
    await trx.rollback();
    return res.status(400).json({ error: e.message || 'Erro ao atualizar projeção.' });
  }
}

/**
 * =============================================================================
 * LOGS
 * =============================================================================
 */
export async function getProjectionLogs(req, res) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });

    const id = Number(req.params.id);
    const logs = await SalesProjectionLog.findAll({
      where: { projection_id: id },
      order: [['created_at', 'DESC']],
      attributes: ['id', 'action', 'user_id', 'payload_before', 'payload_after', 'note', 'created_at'],
      include: User ? [{ model: User, as: 'actor', attributes: ['id', 'username', 'email'], required: false }] : [],
    });

    return res.json(logs);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro ao listar logs.' });
  }
}

/**
 * =============================================================================
 * ENTERPRISE PICKER
 * =============================================================================
 */
export async function listEnterprisesForPicker(req, res) {
  try {
    const isAdmin = req.user?.role === 'admin';
    const userCity = (req.user?.city || '').trim();

    const sql = `
      SELECT DISTINCT ON (ec.erp_id)
             ec.erp_id AS id,
             TRIM(COALESCE(ec.enterprise_name, ec.erp_id)) AS name
      FROM enterprise_cities ec
      WHERE ec.erp_id IS NOT NULL
        ${isAdmin ? '' : `AND ${CITY_EQ(`COALESCE(ec.city_override, ec.default_city)`)} = ${CITY_EQ(`:userCity`)}`}
      ORDER BY ec.erp_id, ec.updated_at DESC, TRIM(COALESCE(ec.enterprise_name, ec.erp_id));
    `;

    const rows = await db.sequelize.query(sql, {
      replacements: isAdmin ? {} : { userCity },
      type: db.Sequelize.QueryTypes.SELECT,
    });

    const map = new Map();
    for (const r of rows) {
      const id = String(r.id);
      if (!map.has(id)) map.set(id, { id, name: r.name });
    }

    const results = [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    return res.json({ count: results.length, results });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro ao listar empreendimentos.' });
  }
}

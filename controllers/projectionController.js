// controllers/projectionsController.js
import db from '../models/sequelize/index.js';
import { resolveUnitsForErp } from '../services/cv/enterpriseUnitsSummaryService.js';
import { visibleErpIds } from '../services/permissions/accessScopeService.js';

const {
  SalesProjection,
  SalesProjectionLine,
  SalesProjectionLog,
  SalesProjectionEnterprise,
  EnterpriseCity,
  CvEnterprise,
  CvEnterpriseStage,
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

// TTL reduzido para "não encontrado": etapas/CCs podem ser cadastrados a qualquer
// momento no CV, então não cacheamos o vazio por muito tempo.
const STAGE_NULL_TTL = 5_000;

/**
 * Cache (process-wide, 30 s) por CC, em cima da COLETA UNIFICADA do serviço de CV
 * (resolveUnitsForErp). Projeção e Viabilidade usam exatamente a mesma coleta.
 */
async function getUnitsResolvedByErpCached(erpId) {
  if (!erpId) return null;

  const key = `erp:${erpId}`;
  const now = Date.now();
  const memo = unitsCache.get(key);
  if (memo) {
    const ttl = memo.data !== null ? UNITS_TTL : STAGE_NULL_TTL;
    if (now - memo.ts < ttl) return memo.data;
  }

  try {
    const data = await resolveUnitsForErp(String(erpId));
    unitsCache.set(key, { ts: now, data });
    return data;
  } catch (e) {
    console.error('[projections][units_summary] erro ao resolver unidades por CC', {
      erpId, message: e?.message,
    });
    unitsCache.set(key, { ts: now, data: null });
    return null;
  }
}

async function enrichDefaultsWithUnits(defaults) {
  if (!Array.isArray(defaults) || defaults.length === 0) return defaults;

  const items = await Promise.all(
    defaults.map(async (d) => {
      const erpId = d?.erp_id != null ? String(d.erp_id) : null;

      // Coleta UNIFICADA (a MESMA da Viabilidade): etapa → CC mestre → empreendimento.
      const unitsSummary = erpId ? await getUnitsResolvedByErpCached(erpId) : null;
      const cvId = unitsSummary?.cvEnterpriseId != null
        ? Number(unitsSummary.cvEnterpriseId)
        : (d?.cv_enterprise_id != null ? Number(d.cv_enterprise_id) : null);

      return {
        ...d,
        cv_enterprise_id: cvId ?? null,
        units_summary: unitsSummary
          ? {
              totalUnits: unitsSummary.totalUnits,
              soldUnits: unitsSummary.soldUnitsStock ?? unitsSummary.soldUnits ?? 0,
              soldUnitsStock: unitsSummary.soldUnitsStock ?? unitsSummary.soldUnits ?? 0,
              reservedUnits: unitsSummary.reservedUnits,
              blockedUnits: unitsSummary.blockedUnits,
              availableUnits: unitsSummary.availableUnits,
              availableInventory: unitsSummary.availableInventory,
            }
          : null,
      };
    })
  );

  // Segmento do CV por empreendimento resolvido (Luxo → SBPE, Popular → MCMV no front).
  try {
    const cvIds = [...new Set(items.map((i) => i.cv_enterprise_id).filter(Boolean))];
    const ents = cvIds.length
      ? await CvEnterprise.findAll({
          where: { idempreendimento: cvIds },
          attributes: ['idempreendimento', 'segmento_nome'],
          raw: true,
        })
      : [];
    const segById = new Map(ents.map((e) => [Number(e.idempreendimento), e.segmento_nome || null]));
    for (const i of items) i.cv_segment = i.cv_enterprise_id ? (segById.get(Number(i.cv_enterprise_id)) ?? null) : null;
  } catch (e) {
    console.error('[projections][cv_segment] erro ao resolver segmento do CV', { message: e?.message });
    for (const i of items) i.cv_segment = i.cv_segment ?? null;
  }

  return items;
}

/**
 * =============================================================================
 * SQL: Allowed (USER)
 * =============================================================================
 * Lista de CCs visíveis ao usuário (accessScopeService) injetada via
 * :allowedErpIds. erp_id nas tabelas de projeção é texto → casa por texto.
 * Fail-closed: os callers NUNCA executam este SQL com lista vazia (retornam
 * resultado vazio antes).
 */
const SQL_ALLOWED = `
WITH allowed AS (
  SELECT DISTINCT t.erp_id::text AS erp_id
  FROM unnest(ARRAY[:allowedErpIds]::bigint[]) AS t(erp_id)
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
  COALESCE(d.custo_loja,0) AS custo_loja,
  COALESCE(d.blocked_considered_available,0) AS blocked_considered_available,
  d.total_units,
  d.manual_city
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
  COALESCE(d.custo_loja,0) AS custo_loja,
  COALESCE(d.blocked_considered_available,0) AS blocked_considered_available,
  d.total_units,
  d.manual_city
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
  COALESCE(d.custo_loja,0) AS custo_loja,
  COALESCE(d.blocked_considered_available,0) AS blocked_considered_available,
  d.total_units,
  d.manual_city
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
  COALESCE(d.custo_loja,0) AS custo_loja,
  COALESCE(d.blocked_considered_available,0) AS blocked_considered_available,
  d.total_units,
  d.manual_city
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
    // Escopo de acesso: null = admin (sem filtro), [] = nada visível
    const allowedErpIds = await visibleErpIds(req.user);
    const isAdmin = allowedErpIds === null;

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

    // fail-closed: escopo vazio → nada visível
    if (!allowedErpIds.length) return res.json([]);

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
      replacements: { allowedErpIds },
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
          custo_loja: Number(d.custo_loja || 0),
          blocked_considered_available: Number(d.blocked_considered_available || 0),
          manual_city: d.manual_city ?? null,
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
            'custo_loja',
            'blocked_considered_available',
          ],
          order: [['enterprise_key', 'ASC'], ['alias_id', 'ASC']],
        });

        const defaultsPlain = defaults.map((d) => (d?.toJSON ? d.toJSON() : d));
        const defaultsEnriched = await enrichDefaultsWithUnits(defaultsPlain);

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

      return res.json({ projection: proj, lines, enterprise_defaults: defaultsEnriched });
    }

    // =========================
    // USER
    // =========================
    // Escopo de acesso (fail-closed: escopo vazio → nada visível)
    const allowedErpIds = (await visibleErpIds(req.user)) || [];
    if (!allowedErpIds.length) {
      return res.json({ projection: proj, lines: [], enterprise_defaults: [] });
    }

    if (includeZero) {
      const defaults = await db.sequelize.query(SQL_USER_PAIRS_ANY_ALLOWED, {
        replacements: { pid: id, allowedErpIds },
        type: db.Sequelize.QueryTypes.SELECT,
      });

      const lines = hasRange
        ? await db.sequelize.query(SQL_USER_LINES_RANGE, {
          replacements: { pid: id, allowedErpIds, start, end },
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
          { replacements: { pid: id, allowedErpIds }, type: db.Sequelize.QueryTypes.SELECT }
        );

      const defaultsEnriched = await enrichDefaultsWithUnits(defaults);

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
        { replacements: { pid: id, allowedErpIds }, type: db.Sequelize.QueryTypes.SELECT }
      );

      const defaults = await db.sequelize.query(
        `${SQL_ALLOWED}
         SELECT
           d.enterprise_key, d.erp_id, d.alias_id,
           d.default_avg_price, d.enterprise_name_cache,
           d.default_marketing_pct, d.default_commission_pct,
           d.total_units, COALESCE(d.custo_loja,0) AS custo_loja,
           COALESCE(d.blocked_considered_available,0) AS blocked_considered_available
         FROM sales_projection_enterprises d
         JOIN allowed a ON a.erp_id = d.erp_id
         WHERE d.projection_id = :pid
           AND d.erp_id IS NOT NULL
         ORDER BY d.enterprise_key ASC, COALESCE(d.alias_id,'default') ASC;`,
        { replacements: { pid: id, allowedErpIds }, type: db.Sequelize.QueryTypes.SELECT }
      );

      const defaultsEnriched = await enrichDefaultsWithUnits(defaults);

      return res.json({ projection: proj, lines, enterprise_defaults: defaultsEnriched });
    }

    const defaults = await db.sequelize.query(SQL_USER_PAIRS_RANGE_REAL, {
      replacements: { pid: id, allowedErpIds, start, end },
      type: db.Sequelize.QueryTypes.SELECT,
    });

    const lines = await db.sequelize.query(SQL_USER_LINES_RANGE, {
      replacements: { pid: id, allowedErpIds, start, end },
      type: db.Sequelize.QueryTypes.SELECT,
    });

    const defaultsEnriched = await enrichDefaultsWithUnits(defaults);

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

      const manual_city = i.city != null ? (String(i.city).trim() || null)
        : i.manual_city != null ? (String(i.manual_city).trim() || null)
        : null;

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
        custo_loja: Number(i.custo_loja ?? i.custoLoja ?? 0),
        blocked_considered_available: Number(i.blocked_considered_available ?? i.blockedConsideredAvailable ?? 0),
        manual_city,
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
        'custo_loja',
        'blocked_considered_available',
        'manual_city',
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
 * DELETE PROJECTION (ADMIN)
 * DELETE /api/projections/:id
 * Remove a projeção e TODOS os seus filhos (linhas, defaults, logs) numa
 * transação. Operação irreversível.
 * =============================================================================
 */
export async function deleteProjection(req, res) {
  const deny = assertAdmin(req, res);
  if (deny) return;

  const trx = await db.sequelize.transaction();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      await trx.rollback();
      return res.status(400).json({ error: 'ID inválido.' });
    }

    const proj = await SalesProjection.findByPk(id, { transaction: trx });
    if (!proj) {
      await trx.rollback();
      return res.status(404).json({ error: 'Projeção não encontrada.' });
    }
    if (proj.is_locked) {
      await trx.rollback();
      return res.status(423).json({ error: 'Projeção bloqueada. Desbloqueie antes de excluir.' });
    }

    await SalesProjectionLine.destroy({ where: { projection_id: id }, transaction: trx });
    await SalesProjectionEnterprise.destroy({ where: { projection_id: id }, transaction: trx });
    await SalesProjectionLog.destroy({ where: { projection_id: id }, transaction: trx });
    await proj.destroy({ transaction: trx });

    await trx.commit();
    return res.json({ ok: true, deleted_id: id });
  } catch (e) {
    console.error(e);
    await trx.rollback();
    return res.status(400).json({ error: e.message || 'Erro ao excluir projeção.' });
  }
}

/**
 * =============================================================================
 * UPSERT GRID (ADMIN) — salvamento UNIFICADO da tela nova
 * PUT /api/projections/:id/grid
 * Body: {
 *   range_start: 'YYYY-MM', range_end: 'YYYY-MM',
 *   defaults: [ ... TODAS as linhas atuais da tela ... ],
 *   lines:    [ ... só células com unidades > 0, dentro do período ... ]
 * }
 *
 * Reconciliação (numa única transação):
 *  - `defaults` é o conjunto AUTORITATIVO de empreendimentos da projeção.
 *  - Empreendimento ausente em `defaults` é REMOVIDO (default + todas as linhas).
 *  - Dentro de [range_start, range_end] as linhas passam a refletir exatamente o
 *    que veio em `lines` (meses zerados/limpos somem). Meses FORA do período ficam intactos.
 * =============================================================================
 */
export async function upsertProjectionGrid(req, res) {
  const deny = assertAdmin(req, res);
  if (deny) return;

  const trx = await db.sequelize.transaction();
  try {
    const id = Number(req.params.id);
    const proj = await SalesProjection.findByPk(id, { transaction: trx });
    if (!proj) { await trx.rollback(); return res.status(404).json({ error: 'Projeção não encontrada.' }); }
    if (proj.is_locked) { await trx.rollback(); return res.status(423).json({ error: 'Projeção bloqueada.' }); }

    const rangeStart = normYM(req.body.range_start);
    const rangeEnd = normYM(req.body.range_end);
    if (rangeStart > rangeEnd) throw new Error('range_start não pode ser maior que range_end.');

    const defaultsIn = Array.isArray(req.body.defaults) ? req.body.defaults : [];
    const linesIn = Array.isArray(req.body.lines) ? req.body.lines : [];

    const pairKey = (ek, alias) => `${String(ek)}|${String(alias || 'default')}`;

    // ---- DEFAULTS (conjunto autoritativo de empreendimentos) ----
    const defDedup = new Map();
    for (const i of defaultsIn) {
      const enterprise_key = String(i.enterprise_key || '').trim();
      if (!enterprise_key) throw new Error('enterprise_key é obrigatório nos defaults.');
      const alias_id = i.alias_id ? String(i.alias_id) : 'default';
      const erp_id = i.erp_id ? String(i.erp_id) : null;

      let total_units = null;
      const tuRaw = (i.total_units ?? i.totalUnits);
      if (tuRaw !== undefined && tuRaw !== null && tuRaw !== '') {
        total_units = Math.max(0, parseInt(tuRaw, 10) || 0);
      }

      const nameCache = (i.enterprise_name_cache ?? i.name);
      const manual_city = i.city != null ? (String(i.city).trim() || null)
        : i.manual_city != null ? (String(i.manual_city).trim() || null)
        : null;

      defDedup.set(pairKey(enterprise_key, alias_id), {
        projection_id: id,
        enterprise_key,
        erp_id,
        alias_id,
        default_avg_price: Number(i.default_avg_price ?? i.defaultPrice ?? 0),
        enterprise_name_cache: nameCache != null ? String(nameCache) : null,
        default_marketing_pct: Number(i.default_marketing_pct ?? 0),
        default_commission_pct: Number(i.default_commission_pct ?? 0),
        total_units,
        custo_loja: Number(i.custo_loja ?? i.custoLoja ?? 0),
        blocked_considered_available: Number(i.blocked_considered_available ?? i.blockedConsideredAvailable ?? 0),
        manual_city,
      });
    }
    const finalDefaults = [...defDedup.values()];
    const keepPairs = new Set(finalDefaults.map((d) => pairKey(d.enterprise_key, d.alias_id)));

    if (finalDefaults.length) {
      await SalesProjectionEnterprise.bulkCreate(finalDefaults, {
        transaction: trx,
        updateOnDuplicate: [
          'erp_id', 'default_avg_price', 'enterprise_name_cache',
          'default_marketing_pct', 'default_commission_pct', 'total_units',
          'custo_loja', 'blocked_considered_available', 'manual_city', 'updated_at',
        ],
      });
    }

    // Remove defaults de empreendimentos que sumiram da tela
    const existingDefaults = await SalesProjectionEnterprise.findAll({ where: { projection_id: id }, transaction: trx });
    const removedEnterprises = existingDefaults.filter(
      (d) => !keepPairs.has(pairKey(d.enterprise_key, d.alias_id))
    );
    if (removedEnterprises.length) {
      await SalesProjectionEnterprise.destroy({ where: { id: removedEnterprises.map((d) => d.id) }, transaction: trx });
    }

    // ---- LINES (só células com unidades > 0, dentro do período) ----
    const lineDedup = new Map();
    for (const r of linesIn) {
      const ym = normYM(r.year_month);
      if (ym < rangeStart || ym > rangeEnd) continue;                 // só o período visível
      const enterprise_key = String(r.enterprise_key || '').trim();
      if (!enterprise_key) throw new Error('enterprise_key é obrigatório nas linhas.');
      const alias_id = r.alias_id ? String(r.alias_id) : 'default';
      if (!keepPairs.has(pairKey(enterprise_key, alias_id))) continue; // ignora linha de emp. removido
      const erp_id = r.erp_id ? String(r.erp_id) : null;
      const nameCache = r.enterprise_name_cache ? String(r.enterprise_name_cache) : null;
      if (!erp_id && !nameCache) throw new Error(`Linha manual precisa enterprise_name_cache (${enterprise_key}).`);

      const units = Math.max(0, parseInt(r.units_target ?? 0, 10));
      if (units <= 0) continue;                                        // sem unidades = sem meta

      lineDedup.set(`${enterprise_key}|${alias_id}|${ym}`, {
        projection_id: id,
        enterprise_key,
        erp_id,
        alias_id,
        year_month: ym,
        units_target: units,
        avg_price_target: Number(r.avg_price_target ?? 0),
        enterprise_name_cache: nameCache,
        marketing_pct: Number(r.marketing_pct ?? 0),
        commission_pct: Number(r.commission_pct ?? 0),
      });
    }
    const finalLines = [...lineDedup.values()];

    if (finalLines.length) {
      await SalesProjectionLine.bulkCreate(finalLines, {
        transaction: trx,
        updateOnDuplicate: [
          'erp_id', 'units_target', 'avg_price_target',
          'enterprise_name_cache', 'marketing_pct', 'commission_pct', 'updated_at',
        ],
      });
    }

    // Reconcilia linhas: apaga meses limpos DENTRO do período e tudo de emp. removido.
    const existingLines = await SalesProjectionLine.findAll({ where: { projection_id: id }, transaction: trx });
    const keepLineKeys = new Set(finalLines.map((l) => `${l.enterprise_key}|${l.alias_id}|${l.year_month}`));
    const linesToDelete = existingLines.filter((l) => {
      const alias = l.alias_id || 'default';
      if (!keepPairs.has(pairKey(l.enterprise_key, alias))) return true; // emp. removido → apaga todas
      const ym = String(l.year_month);
      if (ym < rangeStart || ym > rangeEnd) return false;                 // fora do período → preserva
      return !keepLineKeys.has(`${l.enterprise_key}|${alias}|${ym}`);     // no período mas limpo → apaga
    });
    if (linesToDelete.length) {
      await SalesProjectionLine.destroy({ where: { id: linesToDelete.map((l) => l.id) }, transaction: trx });
    }

    const removedNames = removedEnterprises.map((d) => d.enterprise_name_cache || d.erp_id || d.enterprise_key);
    const noteParts = [
      `${finalDefaults.length} empreendimento(s)`,
      `${finalLines.length} meta(s) mensais`,
      `período ${rangeStart}..${rangeEnd}`,
    ];
    if (removedEnterprises.length) noteParts.push(`removidos: ${removedNames.join(', ')}`);

    await SalesProjectionLog.create(
      {
        projection_id: id,
        action: 'SAVED',
        user_id: req.user.id,
        payload_after: {
          defaults: finalDefaults.length,
          lines: finalLines.length,
          removed_enterprises: removedEnterprises.length,
          range: [rangeStart, rangeEnd],
        },
        note: `Salvou ${noteParts.join(' • ')}.`,
      },
      { transaction: trx }
    );

    await trx.commit();
    return res.json({
      ok: true,
      defaults: finalDefaults.length,
      lines: finalLines.length,
      removed_enterprises: removedEnterprises.length,
    });
  } catch (e) {
    console.error(e);
    await trx.rollback();
    return res.status(400).json({ error: e.message || 'Erro ao salvar projeção.' });
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
      // VIEW_DETAIL era gravado a cada leitura da tela e só poluía a linha do
      // tempo; a tela nova não grava mais, e aqui filtramos o histórico antigo.
      where: { projection_id: id, action: { [Op.ne]: 'VIEW_DETAIL' } },
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
 * REPORT: METAS DA PROJEÇÃO (lado projetado)
 * GET /api/projections/report
 *   Aceita os MESMOS parâmetros do Faturamento (/api/sienge/contracts):
 *   ?startDate=YYYY-MM-DD   (padrão: primeiro dia do mês corrente)
 *   ?endDate=YYYY-MM-DD     (padrão: hoje)
 *   ?enterpriseName=Nome1,Nome2  (opcional, filtra por nome)
 *   ?companyIds / ?enterpriseIds (CSV, opcional)
 *   ?projection_id=N        (padrão: projeção ativa)
 *
 * Devolve APENAS metas (projected_units / projected_vgv por mês e acumulado),
 * mais o recorte de tempo (time_elapsed_pct) usado no cálculo de ritmo.
 *
 * O REALIZADO não sai daqui: a tela Vendas × Projeção o obtém do
 * /api/sienge/contracts, a mesma fonte do Faturamento, para que os dois
 * relatórios nunca divirjam. Ver contractsStore.realizedValueForRow.
 * =============================================================================
 */
export async function getProjectionReport(req, res) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });

    // Escopo de acesso: null = admin (sem filtro), [] = nada visível
    const allowedErpIds = await visibleErpIds(req.user);
    const isAdmin = allowedErpIds === null;

    // ── Parâmetros — idênticos ao getContracts (Faturamento) ─────────────────
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);       // YYYY-MM-DD
    const todayYM  = todayStr.slice(0, 7);                    // YYYY-MM

    const firstOfMonth = `${todayYM}-01`;

    const startDateStr = req.query.startDate || firstOfMonth;
    const endDateStr   = req.query.endDate   || todayStr;

    if (startDateStr > endDateStr) {
      return res.status(400).json({ error: 'startDate não pode ser maior que endDate.' });
    }

    // Deriva meses (para alinhar com projection_lines que são YYYY-MM)
    const startMonth = startDateStr.slice(0, 7);
    const endMonth   = endDateStr.slice(0, 7);

    // ?situation continua sendo aceito para compatibilidade de URL, mas não tem
    // efeito aqui: metas não dependem da situação do contrato.

    // Filtro por nome de empreendimento (igual ao Faturamento)
    let nameList = [];
    if (Array.isArray(req.query.enterpriseName)) {
      nameList = req.query.enterpriseName.map(n => n.trim()).filter(Boolean);
    } else if (typeof req.query.enterpriseName === 'string' && req.query.enterpriseName.trim()) {
      nameList = req.query.enterpriseName.split(',').map(n => n.trim()).filter(Boolean);
    }

    // Filtro por empresa (idêntico ao Faturamento — CSV ou array)
    const parseIdCsv = (v) => {
      if (Array.isArray(v)) {
        return v.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n) && n > 0);
      }
      if (typeof v === 'string' && v.trim().length) {
        return v.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
      }
      return [];
    };
    const companyIdsList = parseIdCsv(req.query.companyIds ?? req.query.companyId);
    const enterpriseIdsList = parseIdCsv(req.query.enterpriseIds ?? req.query.enterpriseId);

    // ── Projeção alvo ─────────────────────────────────────────────────────────
    // O relatório opera SEMPRE sobre uma projeção ativa. Se o cliente passa um
    // projection_id, valida-se que aquela é ativa; senão usa-se a única ativa
    // disponível (o sistema garante "no máximo 1 ativa" em create/clone/update).
    let projection;
    if (req.query.projection_id) {
      projection = await SalesProjection.findByPk(Number(req.query.projection_id), {
        attributes: ['id', 'name', 'is_active', 'is_locked'],
      });
      if (!projection) return res.status(404).json({ error: 'Projeção não encontrada.' });
      if (!projection.is_active) {
        return res.status(400).json({ error: 'Projeção informada não está ativa.' });
      }
    } else {
      projection = await SalesProjection.findOne({
        where: { is_active: true },
        attributes: ['id', 'name', 'is_active', 'is_locked'],
      });
      if (!projection) return res.json({ projection: null, enterprises: [], summary: {} });
    }

    const pid = projection.id;

    // ── Busca defaults (empreendimentos) filtrados por escopo ─────────────────
    // Não-admin: filtro por ids de CC (accessScopeService) via replacements —
    // sem interpolação manual de valores no SQL. enterprise_cities segue no
    // JOIN apenas para resolver a cidade de exibição.
    const defaultsSql = isAdmin
      ? `SELECT DISTINCT ON (d.enterprise_key, COALESCE(d.alias_id,'default'))
           d.enterprise_key, COALESCE(d.alias_id,'default') AS alias_id,
           d.erp_id, d.enterprise_name_cache,
           COALESCE(d.default_avg_price,0) AS default_avg_price,
           d.manual_city,
           ec.default_city, ec.city_override
         FROM sales_projection_enterprises d
         LEFT JOIN enterprise_cities ec ON ec.erp_id = d.erp_id
         WHERE d.projection_id = :pid
         ORDER BY d.enterprise_key, COALESCE(d.alias_id,'default'), d.updated_at DESC`
      : `SELECT DISTINCT ON (d.enterprise_key, COALESCE(d.alias_id,'default'))
           d.enterprise_key, COALESCE(d.alias_id,'default') AS alias_id,
           d.erp_id, d.enterprise_name_cache,
           COALESCE(d.default_avg_price,0) AS default_avg_price,
           d.manual_city,
           ec.default_city, ec.city_override
         FROM sales_projection_enterprises d
         LEFT JOIN enterprise_cities ec ON ec.erp_id = d.erp_id
         WHERE d.projection_id = :pid
           AND NULLIF(regexp_replace(COALESCE(d.erp_id,''), '[^0-9]', '', 'g'), '')::bigint IN (:allowedErpIds)
         ORDER BY d.enterprise_key, COALESCE(d.alias_id,'default'), d.updated_at DESC`;

    // fail-closed: escopo vazio → nem consulta (resultado vazio)
    let defaults = (!isAdmin && !allowedErpIds.length)
      ? []
      : await db.sequelize.query(defaultsSql, {
          replacements: isAdmin ? { pid } : { pid, allowedErpIds },
          type: db.Sequelize.QueryTypes.SELECT,
        });

    // Aplica filtro por nome (igual ao Faturamento)
    if (nameList.length > 0) {
      const normName = (s) => (s || '').trim().toLowerCase();
      const nameSet = new Set(nameList.map(normName));
      defaults = defaults.filter(d => nameSet.has(normName(d.enterprise_name_cache)));
    }

    const emptyResponse = (msg) => res.json({
      projection,
      report_range: { start_date: startDateStr, end_date: endDateStr, start_month: startMonth, end_month: endMonth },
      current_month: todayYM, current_day: today.getDate(),
      days_in_current_month: new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate(),
      time_elapsed_pct: 0,
      summary: { projected_units: 0, projected_vgv: 0, enterprises_total: 0 },
      enterprises: [],
    });

    if (!defaults.length) return emptyResponse();

    // ── Busca linhas de projeção no intervalo ─────────────────────────────────
    const linesSql = `
      SELECT l.enterprise_key, COALESCE(l.alias_id,'default') AS alias_id,
             l.erp_id, l.year_month,
             COALESCE(l.units_target,0)     AS units_target,
             COALESCE(l.avg_price_target,0) AS avg_price_target
      FROM sales_projection_lines l
      WHERE l.projection_id = :pid
        AND l.year_month BETWEEN :startMonth AND :endMonth
      ORDER BY l.enterprise_key, COALESCE(l.alias_id,'default'), l.year_month
    `;
    const lines = await db.sequelize.query(linesSql, {
      replacements: { pid, startMonth, endMonth },
      type: db.Sequelize.QueryTypes.SELECT,
    });

    // ⚠️ Este endpoint devolve SOMENTE o lado projetado (metas).
    //
    // Até 2026-07 ele também agregava os contratos realizados aqui, com uma
    // versão simplificada das regras do Faturamento (sem uplift de comissão,
    // sem exclusão de distrato, sem TR-satélite, contando CONTRATOS em vez de
    // vendas únicas). O resultado nunca era exibido: a tela Vendas × Projeção
    // monta o realizado a partir do contractsStore, exatamente como o
    // Faturamento. Manter os dois cálculos só criava divergência silenciosa e
    // uma agregação cara sobre `contracts` a cada request.
    //
    // Regra: realizado tem UMA fonte só, o /api/sienge/contracts.
    // ── Índices auxiliares ────────────────────────────────────────────────────
    // lines: { `${enterprise_key}|||${alias_id}|||${year_month}` → row }
    const linesIdx = new Map();
    for (const l of lines) {
      linesIdx.set(`${l.enterprise_key}|||${l.alias_id}|||${l.year_month}`, l);
    }

    // ── Meses no intervalo ────────────────────────────────────────────────────
    const allMonths = [];
    let cur = startMonth;
    while (cur <= endMonth) {
      allMonths.push(cur);
      const [y, m] = cur.split('-').map(Number);
      cur = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    }

    // ── Cálculo de % do tempo decorrido no período ────────────────────────────
    const daysInCurrentMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const currentDay         = today.getDate();

    // Proporção do mês atual transcorrida
    const currentMonthElapsedFraction = currentDay / daysInCurrentMonth;

    // time_elapsed_pct: considera apenas o mês atual dentro do range
    let timeElapsedPct = 0;
    if (todayYM < startMonth) {
      timeElapsedPct = 0;                   // período ainda não começou
    } else if (todayYM > endMonth) {
      timeElapsedPct = 100;                 // período encerrado
    } else {
      const totalMonths = allMonths.length;
      const pastMonths  = allMonths.filter(ym => ym < todayYM).length;
      timeElapsedPct    = parseFloat((((pastMonths + currentMonthElapsedFraction) / totalMonths) * 100).toFixed(2));
    }

    // ── Monta os dados por empreendimento ────────────────────────────────────
    const enterprisesMap = new Map();

    for (const d of defaults) {
      const ek  = d.enterprise_key;
      const aid = d.alias_id;
      const key = `${ek}|||${aid}`;
      const erp = d.erp_id ? String(d.erp_id) : null;

      // Nome legível
      const name = (d.enterprise_name_cache || '').trim() ||
                   (erp ? `ERP ${erp}` : ek);

      // Cidade resolvida
      const city = (d.manual_city || d.city_override || d.default_city || '').trim() || null;

      // Meses deste empreendimento
      const monthsData = allMonths.map(ym => {
        const lineKey = `${ek}|||${aid}|||${ym}`;
        const line    = linesIdx.get(lineKey);

        const avgPrice        = line?.avg_price_target > 0 ? Number(line.avg_price_target) : Number(d.default_avg_price);
        const projected_units = line ? Number(line.units_target) : 0;
        const projected_vgv   = projected_units * avgPrice;

        return { year_month: ym, projected_units, projected_vgv, is_future_month: ym > todayYM };
      });

      // Summary do empreendimento (acumulado no período)
      const totalProjectedUnits = monthsData.reduce((s, m) => s + m.projected_units, 0);
      const totalProjectedVgv   = monthsData.reduce((s, m) => s + m.projected_vgv,   0);

      enterprisesMap.set(key, {
        enterprise_key: ek,
        alias_id: aid,
        erp_id: erp,
        name,
        city,
        months: monthsData,
        summary: {
          projected_units: totalProjectedUnits,
          projected_vgv:   totalProjectedVgv,
        },
      });
    }

    const enterprises = [...enterprisesMap.values()].sort((a, b) =>
      (b.summary.projected_vgv) - (a.summary.projected_vgv)
    );

    // ── Enriquece cada empreendimento com company_id via enterprise_cities ────
    // Uma única query para os erp_ids desta projeção — sem scan full-table.
    {
      const erpIds = enterprises.map(e => e.erp_id).filter(id => id != null && id !== '')
      if (erpIds.length > 0) {
        const rows = await db.sequelize.query(
          `SELECT erp_id,
                  (raw_payload->>'idCompany')::int AS company_id,
                  (SELECT sc.company_name FROM contracts sc
                   WHERE sc.company_id = (raw_payload->>'idCompany')::int LIMIT 1) AS company_name
           FROM enterprise_cities
           WHERE source = 'erp'
             AND erp_id IN (:erpIds)`,
          { replacements: { erpIds }, type: db.Sequelize.QueryTypes.SELECT }
        )
        const cidMap = new Map(rows.map(r => [String(r.erp_id), { company_id: r.company_id ?? null, company_name: r.company_name ?? null }]))
        for (const ent of enterprises) {
          const info = ent.erp_id != null ? cidMap.get(String(ent.erp_id)) : null
          ent.company_id   = info?.company_id   ?? null
          ent.company_name = info?.company_name ?? null
        }
      }
    }

    // ── Filtros de empresa / empreendimento ─────────────────────────────────
    // Aplicados após o enrichment de company_id, antes do summary global, para
    // que os agregados reflitam exatamente o recorte exibido no relatório.
    let filteredEnterprises = enterprises
    if (companyIdsList.length > 0) {
      const companySet = new Set(companyIdsList)
      filteredEnterprises = filteredEnterprises.filter((e) => {
        const cid = e.company_id != null ? Number(e.company_id) : null
        // Mesmo comportamento do client antigo: se empresa não foi resolvida, mantém.
        return cid == null || companySet.has(cid)
      })
    }
    if (enterpriseIdsList.length > 0) {
      const entSet = new Set(enterpriseIdsList.map(String))
      filteredEnterprises = filteredEnterprises.filter((e) => {
        const eid = e.erp_id != null ? String(e.erp_id) : null
        return eid != null && entSet.has(eid)
      })
    }

    // ── Summary global (só metas) ─────────────────────────────────────────────
    const summary = {
      projected_units:   filteredEnterprises.reduce((s, e) => s + e.summary.projected_units, 0),
      projected_vgv:     filteredEnterprises.reduce((s, e) => s + e.summary.projected_vgv,   0),
      enterprises_total: filteredEnterprises.length,
    };

    return res.json({
      projection,
      report_range: {
        start_date:  startDateStr,
        end_date:    endDateStr,
        start_month: startMonth,
        end_month:   endMonth,
      },
      current_month:         todayYM,
      current_day:           currentDay,
      days_in_current_month: daysInCurrentMonth,
      time_elapsed_pct:      timeElapsedPct,
      summary,
      enterprises:           filteredEnterprises,
    });

  } catch (e) {
    console.error('[getProjectionReport] erro:', e);
    return res.status(500).json({ error: e.message || 'Erro ao gerar relatório.' });
  }
}

/**
 * =============================================================================
 * ENTERPRISE PICKER
 * =============================================================================
 */
export async function listEnterprisesForPicker(req, res) {
  try {
    // Escopo de acesso: null = admin (sem filtro), [] = nada visível
    const allowedErpIds = await visibleErpIds(req.user);
    const isAdmin = allowedErpIds === null;

    // Admin pode filtrar por cidade via query ?city=... (hint de filtro).
    // Não-admin: sempre trancado no escopo (fail-closed: vazio → lista vazia).
    const requestedCity = isAdmin ? (req.query.city || '').trim() : '';

    if (!isAdmin && !allowedErpIds.length) {
      return res.json({ count: 0, results: [] });
    }

    const whereScope = isAdmin
      ? (requestedCity
          ? `AND ${CITY_EQ(`COALESCE(ec.city_override, ec.default_city)`)} = ${CITY_EQ(`:effectiveCity`)}`
          : '')
      : `AND NULLIF(regexp_replace(ec.erp_id, '[^0-9]', '', 'g'), '')::bigint IN (:allowedErpIds)`;

    // ✅ name volta "como antes" (com ERP embutido)
    // ✅ city volta junto pro front poder usar se quiser
    const sql = `
      SELECT DISTINCT ON (ec.erp_id)
        ec.erp_id AS id,
        (TRIM(COALESCE(ec.enterprise_name, ec.erp_id)) || ' (ERP ' || ec.erp_id || ')') AS name,
        TRIM(COALESCE(ec.city_override, ec.default_city)) AS city
      FROM enterprise_cities ec
      WHERE ec.erp_id IS NOT NULL
        ${whereScope}
      ORDER BY ec.erp_id, ec.updated_at DESC, TRIM(COALESCE(ec.enterprise_name, ec.erp_id));
    `;

    const rows = await db.sequelize.query(sql, {
      replacements: isAdmin
        ? (requestedCity ? { effectiveCity: requestedCity } : {})
        : { allowedErpIds },
      type: db.Sequelize.QueryTypes.SELECT,
    });

    // Dedup defensivo (mesmo com DISTINCT ON)
    const map = new Map();
    for (const r of rows) {
      const id = String(r.id);
      if (!map.has(id)) {
        map.set(id, { id, name: r.name, city: r.city || null });
      }
    }

    const results = [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

    // (Opcional) lista de cidades para o filtro do modal (admin)
    if (isAdmin && String(req.query.with_cities || '') === '1') {
      const citiesSql = `
        SELECT DISTINCT TRIM(COALESCE(ec.city_override, ec.default_city)) AS city
        FROM enterprise_cities ec
        WHERE ec.erp_id IS NOT NULL
          AND TRIM(COALESCE(ec.city_override, ec.default_city)) IS NOT NULL
          AND TRIM(COALESCE(ec.city_override, ec.default_city)) <> ''
        ORDER BY TRIM(COALESCE(ec.city_override, ec.default_city)) ASC;
      `;
      const cityRows = await db.sequelize.query(citiesSql, {
        type: db.Sequelize.QueryTypes.SELECT,
      });
      const cities = (cityRows || []).map((c) => c.city).filter(Boolean);

      return res.json({ count: results.length, results, cities });
    }

    return res.json({ count: results.length, results });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro ao listar empreendimentos.' });
  }
}

/**
 * Mapa de nomes de exibição por centro de custo, vindo da PROJEÇÃO ATIVA (fonte única
 * de naming — o nome editável da projeção), com fallback nos overrides legados para não
 * regredir nomes já cadastrados. Consumido pelo costCenterNamesStore (Custos/Títulos/
 * AutoSync). Substitui o antigo /api/expenses/cost-center-overrides/map.
 * Retorna { "<erp_id>": "Nome" }.
 */
export async function getActiveProjectionCostCenterNames(req, res) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });

    const map = {};

    // fallback legado: overrides existentes (não quebra nomes já cadastrados)
    try {
      const overrides = await db.CostCenterOverride.findAll({ attributes: ['cost_center_id', 'display_name'] });
      for (const o of overrides) {
        if (o.cost_center_id != null && o.display_name) map[String(o.cost_center_id)] = o.display_name;
      }
    } catch (_e) {
      // tabela pode não existir em algum ambiente — segue só com a projeção
    }

    // prioridade: nome da projeção ativa (enterprise_name_cache por erp_id/CC)
    const proj = await db.SalesProjection.findOne({
      where: { is_active: true },
      order: [['updated_at', 'DESC']],
      attributes: ['id'],
    });
    if (proj) {
      const rows = await db.SalesProjectionEnterprise.findAll({
        where: { projection_id: proj.id },
        attributes: ['erp_id', 'enterprise_name_cache'],
      });
      for (const r of rows) {
        if (r.erp_id != null && r.enterprise_name_cache) map[String(r.erp_id)] = r.enterprise_name_cache;
      }
    }

    return res.json(map);
  } catch (e) {
    console.error('[projections] getActiveProjectionCostCenterNames erro', e);
    return res.status(500).json({ error: e.message || 'Erro ao carregar nomes de exibição.' });
  }
}


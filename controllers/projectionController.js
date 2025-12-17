import db from '../models/sequelize/index.js';

const {
  SalesProjection,
  SalesProjectionLine,
  SalesProjectionLog,
  SalesProjectionEnterprise,
  EnterpriseCity,
  Sequelize
} = db;

const { Op } = Sequelize;

const assertAdmin = (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso negado.' });
  return null;
};

// Normalização de cidade: igual ao restante do projeto (ex.: contratos / leads)
const CITY_EQ = (col) => `
  unaccent(upper(regexp_replace(${col}, '[^A-Z0-9]+',' ','g')))
`;

const normYM = (v) => {
  const ym = String(v || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error(`year_month inválido: ${v}`);
  return ym;
};

const getRangeOrNull = (req) => {
  const start = req.query.start_month ? normYM(req.query.start_month) : null;
  const end = req.query.end_month ? normYM(req.query.end_month) : null;
  if ((start && !end) || (!start && end)) {
    throw new Error('Envie start_month e end_month juntos (ou nenhum).');
  }
  if (start && end && start > end) throw new Error('start_month não pode ser maior que end_month');
  return { start, end };
};

const buildYearMonthWhere = ({ start, end }) => {
  if (!start || !end) return {};
  return { year_month: { [Op.between]: [start, end] } };
};

const isManualEnterpriseKey = (enterprise_key) => String(enterprise_key || '').startsWith('MAN:');
const isErpEnterpriseKey = (enterprise_key) => String(enterprise_key || '').startsWith('ERP:');

/**
 * =============================================================================
 * SQL HELPERS PARA "RANGE REAL" (não gerar abr→dez se a projeção real só vai até mar)
 * =============================================================================
 *
 * A ideia:
 * - bounds: calcula min_ym e max_ym por (enterprise_key, alias_id) usando SOMENTE linhas com units_target > 0
 * - pairs_in_view: mantém apenas pares cujo range real intersecta o range solicitado (start/end)
 * - lines: retorna as linhas DO RANGE pedido, mas só para os pares em view
 * - defaults: retorna defaults só para os pares em view (para não "sobrar" empreendimento fantasma no grid)
 */

const SQL_ADMIN_BOUNDS = `
WITH bounds AS (
  SELECT
    l.projection_id,
    l.enterprise_key,
    COALESCE(l.alias_id,'default') AS alias_id,
    MIN(l.year_month) AS min_ym,
    MAX(l.year_month) AS max_ym
  FROM sales_projection_lines l
  WHERE l.projection_id = :pid
    AND COALESCE(l.units_target,0) > 0
  GROUP BY l.projection_id, l.enterprise_key, COALESCE(l.alias_id,'default')
),
pairs_in_view AS (
  SELECT *
  FROM bounds
  WHERE min_ym <= :end
    AND max_ym >= :start
)
SELECT * FROM pairs_in_view;
`;

const SQL_ADMIN_LINES = `
WITH bounds AS (
  SELECT
    l.projection_id,
    l.enterprise_key,
    COALESCE(l.alias_id,'default') AS alias_id,
    MIN(l.year_month) AS min_ym,
    MAX(l.year_month) AS max_ym
  FROM sales_projection_lines l
  WHERE l.projection_id = :pid
    AND COALESCE(l.units_target,0) > 0
  GROUP BY l.projection_id, l.enterprise_key, COALESCE(l.alias_id,'default')
),
pairs_in_view AS (
  SELECT *
  FROM bounds
  WHERE min_ym <= :end
    AND max_ym >= :start
)
SELECT
  l.id, l.enterprise_key, l.erp_id, l.alias_id, l.year_month,
  l.units_target, l.avg_price_target,
  l.enterprise_name_cache, l.created_at, l.updated_at,
  l.marketing_pct, l.commission_pct
FROM sales_projection_lines l
JOIN pairs_in_view p
  ON p.projection_id = l.projection_id
 AND p.enterprise_key = l.enterprise_key
 AND p.alias_id = COALESCE(l.alias_id,'default')
WHERE l.projection_id = :pid
  AND l.year_month BETWEEN :start AND :end
ORDER BY l.enterprise_key ASC, COALESCE(l.alias_id,'default') ASC, l.year_month ASC;
`;

const SQL_ADMIN_DEFAULTS = `
WITH bounds AS (
  SELECT
    l.projection_id,
    l.enterprise_key,
    COALESCE(l.alias_id,'default') AS alias_id,
    MIN(l.year_month) AS min_ym,
    MAX(l.year_month) AS max_ym
  FROM sales_projection_lines l
  WHERE l.projection_id = :pid
    AND COALESCE(l.units_target,0) > 0
  GROUP BY l.projection_id, l.enterprise_key, COALESCE(l.alias_id,'default')
),
pairs_in_view AS (
  SELECT *
  FROM bounds
  WHERE min_ym <= :end
    AND max_ym >= :start
)
SELECT
  d.enterprise_key, d.erp_id, d.alias_id,
  d.default_avg_price, d.enterprise_name_cache,
  d.default_marketing_pct, d.default_commission_pct
FROM sales_projection_enterprises d
JOIN pairs_in_view p
  ON p.projection_id = d.projection_id
 AND p.enterprise_key = d.enterprise_key
 AND p.alias_id = COALESCE(d.alias_id,'default')
WHERE d.projection_id = :pid
ORDER BY d.enterprise_key ASC, COALESCE(d.alias_id,'default') ASC;
`;

const SQL_USER_LINES = `
WITH allowed AS (
  SELECT DISTINCT ec.erp_id
  FROM enterprise_cities ec
  WHERE ec.erp_id IS NOT NULL
    AND ${CITY_EQ(`COALESCE(ec.city_override, ec.default_city)`)} = ${CITY_EQ(`:userCity`)}
),
bounds AS (
  SELECT
    l.projection_id,
    l.enterprise_key,
    COALESCE(l.alias_id,'default') AS alias_id,
    MIN(l.year_month) AS min_ym,
    MAX(l.year_month) AS max_ym,
    l.erp_id
  FROM sales_projection_lines l
  JOIN allowed a ON a.erp_id = l.erp_id
  WHERE l.projection_id = :pid
    AND l.erp_id IS NOT NULL
    AND COALESCE(l.units_target,0) > 0
  GROUP BY l.projection_id, l.enterprise_key, COALESCE(l.alias_id,'default'), l.erp_id
),
pairs_in_view AS (
  SELECT *
  FROM bounds
  WHERE min_ym <= :end
    AND max_ym >= :start
)
SELECT
  l.id, l.enterprise_key, l.erp_id, l.alias_id, l.year_month,
  l.units_target, l.avg_price_target,
  l.enterprise_name_cache, l.created_at, l.updated_at,
  l.marketing_pct, l.commission_pct
FROM sales_projection_lines l
JOIN pairs_in_view p
  ON p.projection_id = l.projection_id
 AND p.enterprise_key = l.enterprise_key
 AND p.alias_id = COALESCE(l.alias_id,'default')
 AND p.erp_id = l.erp_id
WHERE l.projection_id = :pid
  AND l.erp_id IS NOT NULL
  AND l.year_month BETWEEN :start AND :end
ORDER BY l.enterprise_key ASC, COALESCE(l.alias_id,'default') ASC, l.year_month ASC;
`;

const SQL_USER_DEFAULTS = `
WITH allowed AS (
  SELECT DISTINCT ec.erp_id
  FROM enterprise_cities ec
  WHERE ec.erp_id IS NOT NULL
    AND ${CITY_EQ(`COALESCE(ec.city_override, ec.default_city)`)} = ${CITY_EQ(`:userCity`)}
),
bounds AS (
  SELECT
    l.projection_id,
    l.enterprise_key,
    COALESCE(l.alias_id,'default') AS alias_id,
    MIN(l.year_month) AS min_ym,
    MAX(l.year_month) AS max_ym,
    l.erp_id
  FROM sales_projection_lines l
  JOIN allowed a ON a.erp_id = l.erp_id
  WHERE l.projection_id = :pid
    AND l.erp_id IS NOT NULL
    AND COALESCE(l.units_target,0) > 0
  GROUP BY l.projection_id, l.enterprise_key, COALESCE(l.alias_id,'default'), l.erp_id
),
pairs_in_view AS (
  SELECT *
  FROM bounds
  WHERE min_ym <= :end
    AND max_ym >= :start
)
SELECT
  d.enterprise_key, d.erp_id, d.alias_id,
  d.default_avg_price, d.enterprise_name_cache,
  d.default_marketing_pct, d.default_commission_pct
FROM sales_projection_enterprises d
JOIN pairs_in_view p
  ON p.projection_id = d.projection_id
 AND p.enterprise_key = d.enterprise_key
 AND p.alias_id = COALESCE(d.alias_id,'default')
 AND p.erp_id = d.erp_id
JOIN allowed a ON a.erp_id = d.erp_id
WHERE d.projection_id = :pid
  AND d.erp_id IS NOT NULL
ORDER BY d.enterprise_key ASC, COALESCE(d.alias_id,'default') ASC;
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
        order: [
          ['is_active', 'DESC'],
          ['updated_at', 'DESC'],
          ['name', 'ASC'],
        ],
      });
      return res.json(rows);
    }

    if (!userCity) {
      return res.status(400).json({ error: 'Cidade do usuário ausente no token.' });
    }

    const sql = `
      WITH allowed AS (
        SELECT DISTINCT ec.erp_id
        FROM enterprise_cities ec
        WHERE ec.erp_id IS NOT NULL
          AND ${CITY_EQ(`COALESCE(ec.city_override, ec.default_city)`)} = ${CITY_EQ(`:userCity`)}
      ),
      visible AS (
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
// POST /api/projections
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
      {
        name: String(name),
        is_locked: false,
        is_active: !!is_active,
        created_by: req.user.id,
      },
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
// POST /api/projections/clone
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
      {
        name: String(name),
        is_locked: false,
        is_active: !!is_active,
        created_by: req.user.id,
      },
      { transaction: trx }
    );

    const srcDefaults = await SalesProjectionEnterprise.findAll({
      where: { projection_id: source.id },
      transaction: trx,
    });

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
        })),
        { transaction: trx }
      );
    }

    const srcLines = await SalesProjectionLine.findAll({
      where: { projection_id: source.id },
      transaction: trx,
    });

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
 * GET PROJECTION DETAIL
 * =============================================================================
 * Agora:
 * - Se start/end vierem: devolve só pares cujo "range real" (com units>0) intersecta start/end
 * - E devolve linhas só do período pedido (start→end), mas apenas desses pares.
 */
// GET /api/projections/:id?start_month=YYYY-MM&end_month=YYYY-MM
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
    const { start, end } = getRangeOrNull(req);

    // Se não mandou range, mantém comportamento antigo (não mexe)
    if (!start || !end) {
      if (isAdmin) {
        const lines = await SalesProjectionLine.findAll({
          where: { projection_id: id },
          attributes: [
            'id', 'enterprise_key', 'erp_id', 'alias_id', 'year_month',
            'units_target', 'avg_price_target', 'enterprise_name_cache',
            'created_at', 'updated_at', 'marketing_pct', 'commission_pct',
          ],
          order: [['enterprise_key', 'ASC'], ['alias_id', 'ASC'], ['year_month', 'ASC']],
        });

        const defaults = await SalesProjectionEnterprise.findAll({
          where: { projection_id: id },
          attributes: [
            'enterprise_key', 'erp_id', 'alias_id',
            'default_avg_price', 'enterprise_name_cache',
            'default_marketing_pct', 'default_commission_pct',
          ],
          order: [['enterprise_key', 'ASC'], ['alias_id', 'ASC']],
        });

        return res.json({ projection: proj, lines, enterprise_defaults: defaults });
      }

      // USER sem range -> mantém comportamento antigo (mas ainda filtra allowed)
      const userCity = (req.user.city || '').trim();
      if (!userCity) return res.status(400).json({ error: 'Cidade do usuário ausente no token.' });

      const sqlLines = `
        WITH allowed AS (
          SELECT DISTINCT ec.erp_id
          FROM enterprise_cities ec
          WHERE ec.erp_id IS NOT NULL
            AND ${CITY_EQ(`COALESCE(ec.city_override, ec.default_city)`)} = ${CITY_EQ(`:userCity`)}
        )
        SELECT
          l.id, l.enterprise_key, l.erp_id, l.alias_id, l.year_month,
          l.units_target, l.avg_price_target,
          l.enterprise_name_cache, l.created_at, l.updated_at,
          l.marketing_pct, l.commission_pct
        FROM sales_projection_lines l
        JOIN allowed a ON a.erp_id = l.erp_id
        WHERE l.projection_id = :pid
          AND l.erp_id IS NOT NULL
        ORDER BY l.enterprise_key ASC, l.alias_id ASC, l.year_month ASC;
      `;

      const lines = await db.sequelize.query(sqlLines, {
        replacements: { pid: id, userCity },
        type: db.Sequelize.QueryTypes.SELECT,
      });

      const sqlDefaults = `
        WITH allowed AS (
          SELECT DISTINCT ec.erp_id
          FROM enterprise_cities ec
          WHERE ec.erp_id IS NOT NULL
            AND ${CITY_EQ(`COALESCE(ec.city_override, ec.default_city)`)} = ${CITY_EQ(`:userCity`)}
        )
        SELECT
          d.enterprise_key, d.erp_id, d.alias_id,
          d.default_avg_price, d.enterprise_name_cache,
          d.default_marketing_pct, d.default_commission_pct
        FROM sales_projection_enterprises d
        JOIN allowed a ON a.erp_id = d.erp_id
        WHERE d.projection_id = :pid
          AND d.erp_id IS NOT NULL
        ORDER BY d.enterprise_key ASC, d.alias_id ASC;
      `;

      const defaults = await db.sequelize.query(sqlDefaults, {
        replacements: { pid: id, userCity },
        type: db.Sequelize.QueryTypes.SELECT,
      });

      return res.json({ projection: proj, lines, enterprise_defaults: defaults });
    }

    // ====== COM RANGE (start/end) ======
    if (isAdmin) {
      const lines = await db.sequelize.query(SQL_ADMIN_LINES, {
        replacements: { pid: id, start, end },
        type: db.Sequelize.QueryTypes.SELECT,
      });

      const defaults = await db.sequelize.query(SQL_ADMIN_DEFAULTS, {
        replacements: { pid: id, start, end },
        type: db.Sequelize.QueryTypes.SELECT,
      });

      return res.json({ projection: proj, lines, enterprise_defaults: defaults });
    }

    // USER COM RANGE
    const userCity = (req.user.city || '').trim();
    if (!userCity) return res.status(400).json({ error: 'Cidade do usuário ausente no token.' });

    const lines = await db.sequelize.query(SQL_USER_LINES, {
      replacements: { pid: id, userCity, start, end },
      type: db.Sequelize.QueryTypes.SELECT,
    });

    const defaults = await db.sequelize.query(SQL_USER_DEFAULTS, {
      replacements: { pid: id, userCity, start, end },
      type: db.Sequelize.QueryTypes.SELECT,
    });

    return res.json({ projection: proj, lines, enterprise_defaults: defaults });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Erro ao carregar projeção.' });
  }
}

/**
 * =============================================================================
 * UPSERT DEFAULTS (ADMIN)
 * =============================================================================
 */
export async function upsertProjectionDefaults(req, res) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  const trx = await db.sequelize.transaction();
  try {
    const id = Number(req.params.id);
    let { items, remove_missing } = req.body;
    remove_missing = !!remove_missing;

    if (!Array.isArray(items) || !items.length) {
      await trx.rollback();
      return res.status(400).json({ error: 'Envie items com pelo menos um item.' });
    }

    const incoming = items.map((i) => {
      const enterprise_key = String(i.enterprise_key || '').trim();
      if (!enterprise_key) throw new Error('enterprise_key é obrigatório nos defaults.');

      return {
        projection_id: id,
        enterprise_key,
        erp_id: i.erp_id ? String(i.erp_id) : null,
        alias_id: i.alias_id ? String(i.alias_id) : 'default',
        default_avg_price: Number(i.default_avg_price ?? 0),
        enterprise_name_cache: i.enterprise_name_cache || null,
        default_marketing_pct: Number(i.default_marketing_pct ?? 0),
        default_commission_pct: Number(i.default_commission_pct ?? 0),
      };
    });

    const key = (r) => `${r.enterprise_key}|${r.alias_id}`;
    const dedupMap = new Map();
    for (const r of incoming) dedupMap.set(key(r), r);
    const finalItems = [...dedupMap.values()];

    const before = await db.SalesProjectionEnterprise.findAll({
      where: { projection_id: id },
      transaction: trx,
    });

    const beforeMap = new Map(before.map((r) => [key(r), r.toJSON()]));
    const afterMap = new Map(finalItems.map((r) => [key(r), r]));

    await db.SalesProjectionEnterprise.bulkCreate(finalItems, {
      transaction: trx,
      updateOnDuplicate: [
        'erp_id',
        'default_avg_price',
        'enterprise_name_cache',
        'default_marketing_pct',
        'default_commission_pct',
        'updated_at',
      ],
    });

    let removedKeys = [];
    if (remove_missing) {
      const incomingKeys = new Set(finalItems.map((r) => key(r)));
      const toRemove = before.filter((r) => !incomingKeys.has(key(r)));
      if (toRemove.length) {
        removedKeys = toRemove.map((r) => key(r));
        await db.SalesProjectionEnterprise.destroy({
          where: { id: toRemove.map((r) => r.id) },
          transaction: trx,
        });
      }
    }

    const { summary, note } = summarizeDefaultsChange({ beforeMap, afterMap, removedKeys });

    await db.SalesProjectionLog.create(
      {
        projection_id: id,
        action: 'UPSERT_DEFAULTS',
        user_id: req.user.id,
        payload_after: { count: finalItems.length, remove_missing, summary },
        note,
      },
      { transaction: trx }
    );

    await trx.commit();
    return res.json({ ok: true, upserted: finalItems.length, removed: removedKeys.length, summary });
  } catch (e) {
    await trx.rollback();
    return res.status(400).json({ error: e.message || 'Erro ao salvar defaults.' });
  }
}

/**
 * =============================================================================
 * UPSERT LINES (ADMIN)
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

    const proj = await db.SalesProjection.findByPk(id, { transaction: trx });
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

    const key = (r) =>
      `${id}|${String(r.enterprise_key)}|${String(r.alias_id || 'default')}|${normYM(r.year_month)}`;

    const map = new Map();

    for (const r of rows) {
      const ym = normYM(r.year_month);
      const enterprise_key = String(r.enterprise_key || '').trim();
      if (!enterprise_key) throw new Error('enterprise_key é obrigatório.');

      const alias_id = r.alias_id ? String(r.alias_id) : 'default'; // ✅ normaliza
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

    const whereTouched = {
      projection_id: id,
      [db.Sequelize.Op.or]: normalized.map((n) => ({
        enterprise_key: n.enterprise_key,
        alias_id: n.alias_id,
        year_month: n.year_month,
      })),
    };

    const beforeTouched = await db.SalesProjectionLine.findAll({ where: whereTouched, transaction: trx });
    const beforeTotals = beforeTouched.reduce(
      (acc, r) => {
        const u = Number(r.units_target || 0);
        const p = Number(r.avg_price_target || 0);
        acc.units += u;
        acc.revenue += u * p;
        return acc;
      },
      { units: 0, revenue: 0 }
    );

    await db.SalesProjectionLine.bulkCreate(normalized, {
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

    const afterTouched = await db.SalesProjectionLine.findAll({ where: whereTouched, transaction: trx });
    const afterTotals = afterTouched.reduce(
      (acc, r) => {
        const u = Number(r.units_target || 0);
        const p = Number(r.avg_price_target || 0);
        acc.units += u;
        acc.revenue += u * p;
        return acc;
      },
      { units: 0, revenue: 0 }
    );

    const enterprisesAffected = new Set(normalized.map((n) => `${n.enterprise_key}|${n.alias_id}`)).size;
    const monthsAffected = new Set(normalized.map((n) => n.year_month)).size;

    let removedPairs = [];
    if (remove_missing) {
      const keepPairs = new Set(normalized.map((n) => `${n.enterprise_key}|${n.alias_id}`));
      const existing = await db.SalesProjectionLine.findAll({
        where: { projection_id: id },
        transaction: trx,
      });

      const toDelete = existing.filter((r) => !keepPairs.has(`${r.enterprise_key}|${r.alias_id || 'default'}`));
      if (toDelete.length) {
        removedPairs = [...new Set(toDelete.map((r) => `${r.enterprise_key}|${r.alias_id || 'default'}`))];
        await db.SalesProjectionLine.destroy({
          where: { id: toDelete.map((r) => r.id) },
          transaction: trx,
        });
      }
    }

    const { summary, note } = summarizeLinesChange({
      beforeTotals,
      afterTotals,
      enterprisesAffected,
      monthsAffected,
    });

    await db.SalesProjectionLog.create(
      {
        projection_id: id,
        action: 'UPSERT_LINES',
        user_id: req.user.id,
        payload_after: { count: normalized.length, summary, remove_missing, removed_pairs: removedPairs },
        note: removedPairs.length
          ? `${note} • ${removedPairs.length} par(es) removido(s): ${removedPairs.join(', ')}`
          : note,
      },
      { transaction: trx }
    );

    await trx.commit();
    return res.json({ ok: true, upserted: normalized.length, removed_pairs: removedPairs, summary });
  } catch (e) {
    console.error(e);
    await trx.rollback();
    return res.status(400).json({ error: e.message || 'Erro ao salvar linhas.' });
  }
}

/**
 * =============================================================================
 * UPDATE META (ADMIN)
 * =============================================================================
 */
// PATCH /api/projections/:id
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
        `status: ${changes.is_locked.from ? 'Bloqueada' : 'Aberta'} → ${changes.is_locked.to ? 'Bloqueada' : 'Aberta'}`
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
    return res.json({
      id: proj.id,
      name: proj.name,
      is_locked: proj.is_locked,
      is_active: proj.is_active,
    });
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
// GET /api/projections/:id/logs
export async function getProjectionLogs(req, res) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });

    const id = Number(req.params.id);
    const logs = await db.SalesProjectionLog.findAll({
      where: { projection_id: id },
      order: [['created_at', 'DESC']],
      attributes: ['id', 'action', 'user_id', 'payload_before', 'payload_after', 'note', 'created_at'],
      include: [{ model: db.User, as: 'actor', attributes: ['id', 'username', 'email'] }],
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
// GET /api/projections/enterprise-picker
export async function listEnterprisesForPicker(req, res) {
  try {
    const isAdmin = req.user?.role === 'admin';
    const userCity = req.user?.city || '';

    const sql = `
      SELECT DISTINCT ON (ec.erp_id)
             ec.erp_id AS id,
             TRIM(COALESCE(ec.enterprise_name, ec.erp_id)) AS name
      FROM enterprise_cities ec
      WHERE ec.erp_id IS NOT NULL
        ${isAdmin
        ? ''
        : `
          AND ${CITY_EQ(`COALESCE(ec.city_override, ec.default_city)`)} = ${CITY_EQ(`:userCity`)}
        `}
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
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao listar empreendimentos.' });
  }
}

/**
 * =============================================================================
 * HELPERS (LOG SUMMARY)
 * =============================================================================
 */
function summarizeDefaultsChange({ beforeMap, afterMap, removedKeys }) {
  const added = [];
  const removed = [];
  const price_changed = [];
  const renamed = [];

  for (const [k, v] of afterMap.entries()) {
    const prev = beforeMap.get(k);
    if (!prev) {
      added.push({ enterprise_key: v.enterprise_key, alias_id: v.alias_id });
    } else {
      const pFrom = Number(prev.default_avg_price || 0);
      const pTo = Number(v.default_avg_price || 0);
      if (pFrom !== pTo) {
        price_changed.push({
          enterprise_key: v.enterprise_key,
          alias_id: v.alias_id,
          from: pFrom,
          to: pTo,
        });
      }
      const nFrom = prev.enterprise_name_cache || null;
      const nTo = v.enterprise_name_cache || null;
      if (nFrom !== nTo) {
        renamed.push({
          enterprise_key: v.enterprise_key,
          alias_id: v.alias_id,
          from: nFrom,
          to: nTo,
        });
      }
    }
  }

  for (const k of removedKeys) {
    const prev = beforeMap.get(k);
    if (prev) removed.push({ enterprise_key: prev.enterprise_key, alias_id: prev.alias_id });
  }

  const noteParts = [];
  if (added.length) noteParts.push(`${added.length} adicionado(s)`);
  if (removed.length) noteParts.push(`${removed.length} removido(s)`);
  if (price_changed.length) noteParts.push(`${price_changed.length} preço(s) alterado(s)`);
  if (renamed.length) noteParts.push(`${renamed.length} renomeado(s)`);

  const note = noteParts.length ? `Defaults: ${noteParts.join(', ')}.` : 'Defaults: nenhuma mudança relevante.';
  return { summary: { added, removed, price_changed, renamed }, note };
}

function summarizeLinesChange({ beforeTotals, afterTotals, enterprisesAffected, monthsAffected }) {
  const unitsDelta = Number(afterTotals.units) - Number(beforeTotals.units);
  const revenueDelta = Number(afterTotals.revenue) - Number(beforeTotals.revenue);

  const note = [
    'Linhas:',
    `${enterprisesAffected} empreendimento(s) afetado(s)`,
    `${monthsAffected} mês(es) tocado(s)`,
    `Δ unidades = ${unitsDelta}`,
    `Δ receita = R$ ${revenueDelta.toFixed(2)}`,
  ].join(' • ');

  return {
    summary: {
      enterprises_affected: enterprisesAffected,
      months_affected: monthsAffected,
      units_delta: unitsDelta,
      revenue_delta: Number(revenueDelta.toFixed(2)),
    },
    note,
  };
}

// controllers/projectionsController.js
import db from '../models/sequelize/index.js';
import {
  summarizeUnitsFromDb,
  summarizeUnitsFromStageInt,
  summarizeMasterCcFromDb,
} from '../services/cv/enterpriseUnitsSummaryService.js';

const {
  SalesProjection,
  SalesProjectionLine,
  SalesProjectionLog,
  SalesProjectionEnterprise,
  EnterpriseCity,
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

/**
 * Tenta resolver o summary de unidades pelo idetapa_int (CC Sienge) antes de
 * cair no lookup de nível empresa. Isso permite que módulos distintos de um
 * mesmo empreendimento (ex: MÓD 1 → 99901, MÓD 2 → 99903, MÓD 3 → 99905)
 * mostrem a contagem correta de unidades da sua etapa específica no CV.
 *
 * Retorna o summary (pode ser { totalUnits:0,... }) ou null quando a etapa
 * não existe — nesse caso o caller pode tentar o fallback de nível empresa.
 */
// TTL reduzido para resultados "não encontrado": etapas podem ser cadastradas
// a qualquer momento no CV, então não queremos cachear o vazio por muito tempo.
const STAGE_NULL_TTL = 5_000; // 5 s para null; resultados positivos usam UNITS_TTL

async function getUnitsSummaryByStageIntCached(idetapa_int) {
  if (!idetapa_int) return null;

  const key = `stage:${idetapa_int}`;
  const now = Date.now();
  const memo = unitsCache.get(key);
  if (memo) {
    const ttl = memo.data !== null ? UNITS_TTL : STAGE_NULL_TTL;
    if (now - memo.ts < ttl) return memo.data;
  }

  try {
    const data = await summarizeUnitsFromStageInt(String(idetapa_int));
    unitsCache.set(key, { ts: now, data });
    return data; // null = etapa não encontrada (expira em 5 s)
  } catch (e) {
    console.error('[projections][units_summary] erro ao carregar CV por etapa', {
      idetapa_int,
      message: e?.message,
    });
    unitsCache.set(key, { ts: now, data: null });
    return null;
  }
}

/**
 * Cache para CC mestre — chave única por (cvEnterpriseId, masterErpId).
 * Permite reusar o resultado sem re-calcular na mesma janela de 30 s.
 */
async function getMasterCcSummaryCached(cvEnterpriseId, masterErpId) {
  if (!cvEnterpriseId || !masterErpId) return null;

  const key = `master:${cvEnterpriseId}:${masterErpId}`;
  const now = Date.now();
  const memo = unitsCache.get(key);
  if (memo && now - memo.ts < UNITS_TTL) return memo.data;

  try {
    const data = await summarizeMasterCcFromDb(Number(cvEnterpriseId), masterErpId);
    unitsCache.set(key, { ts: now, data });
    return data;
  } catch (e) {
    console.error('[projections][units_summary] erro ao calcular CC mestre', {
      cvEnterpriseId, masterErpId, message: e?.message,
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

  const items = await Promise.all(
    defaults.map(async (d) => {
      const erpId = d?.erp_id != null ? String(d.erp_id) : null;
      let cvId = d?.cv_enterprise_id != null ? Number(d.cv_enterprise_id) : undefined;

      let unitsSummary = null;

      // 1) PRIORIDADE: etapa específica no CV via idetapa_int
      if (erpId) {
        const stageData = await getUnitsSummaryByStageIntCached(erpId);
        if (stageData) {
          unitsSummary = stageData;
          if (!cvId) cvId = stageData.cvEnterpriseId ?? null;
        }
      }

      // 2) FALLBACK: se não existe etapa, tenta resolver como CC mestre
      if (!unitsSummary && erpId) {
        const resolvedCvId = await resolveCvEnterpriseIdByErp({ erpId });
        if (resolvedCvId) {
          cvId = resolvedCvId;
          unitsSummary = await getMasterCcSummaryCached(cvId, erpId);
        }
      }

      // 3) FALLBACK final: resumo do empreendimento completo
      if (!unitsSummary && cvId) {
        unitsSummary = await getUnitsSummaryCached(cvId);
      }

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

  return items;
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
 * REPORT: REALIZADO × PROJETADO
 * GET /api/projections/report
 *   Aceita os MESMOS parâmetros do Faturamento (/api/sienge/contracts):
 *   ?startDate=YYYY-MM-DD   (padrão: primeiro dia do mês corrente)
 *   ?endDate=YYYY-MM-DD     (padrão: hoje)
 *   ?situation=Emitido      (padrão: Emitido)
 *   ?enterpriseName=Nome1,Nome2  (opcional, filtra por nome)
 *   ?projection_id=N        (padrão: projeção ativa)
 *
 * Regras de VGV (idênticas ao Faturamento):
 *  - VGV Net  = soma de condições que NÃO são DC/DESCONTO_CONSTRUTORA
 *  - VGV Gross = VGV Net + abs(condições de desconto)
 *  - Enterprise 17004: usa land_value diretamente (LAND_VALUE_ONLY)
 *
 * Status (baseado em performance_ratio = achievement_pct / time_elapsed_pct):
 *  ahead    ≥ 1.10
 *  on_track 0.80–1.10
 *  behind   0.40–0.80
 *  at_risk  < 0.40
 *  no_sales sem realized_vgv no período
 *  no_projection sem projected_vgv no período
 * =============================================================================
 */
export async function getProjectionReport(req, res) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });

    const isAdmin  = req.user.role === 'admin';
    const userCity = (req.user.city || '').trim();
    if (!isAdmin && !userCity) {
      return res.status(400).json({ error: 'Cidade do usuário ausente no token.' });
    }

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

    // Situação (igual ao Faturamento, default 'Emitido')
    const validSituations = ['Emitido', 'Autorizado', 'Cancelado'];
    const situation = validSituations.includes(req.query.situation) ? req.query.situation : 'Emitido';

    // Filtro por nome de empreendimento (igual ao Faturamento)
    let nameList = [];
    if (Array.isArray(req.query.enterpriseName)) {
      nameList = req.query.enterpriseName.map(n => n.trim()).filter(Boolean);
    } else if (typeof req.query.enterpriseName === 'string' && req.query.enterpriseName.trim()) {
      nameList = req.query.enterpriseName.split(',').map(n => n.trim()).filter(Boolean);
    }

    // ── Projeção alvo ─────────────────────────────────────────────────────────
    let projection;
    if (req.query.projection_id) {
      projection = await SalesProjection.findByPk(Number(req.query.projection_id), {
        attributes: ['id', 'name', 'is_active', 'is_locked'],
      });
      if (!projection) return res.status(404).json({ error: 'Projeção não encontrada.' });
    } else {
      projection = await SalesProjection.findOne({
        where: { is_active: true },
        attributes: ['id', 'name', 'is_active', 'is_locked'],
      });
      if (!projection) return res.json({ projection: null, enterprises: [], summary: {} });
    }

    const pid = projection.id;

    // ── Busca defaults (empreendimentos) filtrados por cidade ─────────────────
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
         JOIN enterprise_cities ec ON ec.erp_id = d.erp_id
         WHERE d.projection_id = :pid
           AND ${CITY_EQ(`COALESCE(ec.city_override, ec.default_city)`)} = ${CITY_EQ(`'${userCity.replace(/'/g, "''")}'`)}
         ORDER BY d.enterprise_key, COALESCE(d.alias_id,'default'), d.updated_at DESC`;

    let defaults = await db.sequelize.query(defaultsSql, {
      replacements: { pid },
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
      summary: {
        projected_units: 0, realized_units: 0, projected_vgv: 0,
        realized_vgv_net: 0, realized_vgv_gross: 0, realized_vgv: 0,
        achievement_pct: 0, enterprises_total: 0, enterprises_ahead: 0,
        enterprises_on_track: 0, enterprises_behind: 0, enterprises_at_risk: 0,
        enterprises_no_sales: 0,
      },
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

    // ── Busca contratos realizados — MESMA lógica do Faturamento (replacements + IN) ──
    const erpIds = [...new Set(
      defaults.map(d => d.erp_id).filter(v => v != null && String(v) !== 'null').map(String)
    )];
    let contractRows = [];
    if (erpIds.length > 0) {
      // Usa replacements + IN (:erpIds) — exatamente igual ao getContracts do Faturamento
      const whereNameClauses = nameList.map((_, i) => `LOWER(c.enterprise_name) = LOWER(:cname${i})`).join(' OR ');
      const whereNameClause  = nameList.length > 0 ? `AND (${whereNameClauses})` : '';

      const contractSql = `
        SELECT
          c.enterprise_id::text AS erp_id,
          TO_CHAR(c.financial_institution_date, 'YYYY-MM') AS year_month,
          COUNT(*) AS realized_units,

          SUM(
            CASE
              WHEN c.enterprise_id = 17004
                THEN COALESCE(
                  CASE
                    WHEN position(',' in c.land_value::text) > 0
                      THEN replace(regexp_replace(c.land_value::text, E'\\.', '', 'g'), ',', '.')::numeric
                    ELSE regexp_replace(c.land_value::text, E'[^0-9.]', '', 'g')::numeric
                  END, 0)
              ELSE COALESCE((
                SELECT SUM(
                  CASE WHEN upper(pc->>'condition_type_id') NOT IN ('DC','DESCONTO_CONSTRUTORA')
                       THEN (pc->>'total_value')::numeric ELSE 0 END
                )
                FROM jsonb_array_elements(COALESCE(c.payment_conditions, '[]'::jsonb)) pc
              ), 0)
            END
          ) AS realized_vgv_net,

          SUM(
            CASE
              WHEN c.enterprise_id = 17004
                THEN COALESCE(
                  CASE
                    WHEN position(',' in c.land_value::text) > 0
                      THEN replace(regexp_replace(c.land_value::text, E'\\.', '', 'g'), ',', '.')::numeric
                    ELSE regexp_replace(c.land_value::text, E'[^0-9.]', '', 'g')::numeric
                  END, 0)
              ELSE COALESCE((
                SELECT SUM(
                  CASE WHEN upper(pc->>'condition_type_id') NOT IN ('DC','DESCONTO_CONSTRUTORA')
                       THEN (pc->>'total_value')::numeric
                       ELSE ABS((pc->>'total_value')::numeric) END
                )
                FROM jsonb_array_elements(COALESCE(c.payment_conditions, '[]'::jsonb)) pc
              ), 0)
            END
          ) AS realized_vgv_gross

        FROM contracts c
        WHERE c.enterprise_id::text IN (:erpIds)
          AND c.situation = :situation
          AND c.financial_institution_date BETWEEN :startDate::date AND :endDate::date
          ${whereNameClause}
        GROUP BY c.enterprise_id::text,
                 TO_CHAR(c.financial_institution_date, 'YYYY-MM')
      `;

      const replacements = { erpIds, situation, startDate: startDateStr, endDate: endDateStr };
      nameList.forEach((val, i) => { replacements[`cname${i}`] = val; });

      contractRows = await db.sequelize.query(contractSql, {
        replacements,
        type: db.Sequelize.QueryTypes.SELECT,
      });
    }

    // ── Índices auxiliares ────────────────────────────────────────────────────
    // lines: { `${enterprise_key}|||${alias_id}|||${year_month}` → row }
    const linesIdx = new Map();
    for (const l of lines) {
      linesIdx.set(`${l.enterprise_key}|||${l.alias_id}|||${l.year_month}`, l);
    }
    // contracts: { `${erp_id}|||${year_month}` → { units, vgv_net, vgv_gross } }
    const contractIdx = new Map();
    for (const c of contractRows) {
      contractIdx.set(`${c.erp_id}|||${c.year_month}`, {
        realized_units:    Number(c.realized_units)    || 0,
        realized_vgv_net:  Number(c.realized_vgv_net)  || 0,
        realized_vgv_gross: Number(c.realized_vgv_gross) || 0,
      });
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
        const lineKey     = `${ek}|||${aid}|||${ym}`;
        const line        = linesIdx.get(lineKey);
        const contractKey = erp ? `${erp}|||${ym}` : null;
        const contract    = contractKey ? (contractIdx.get(contractKey) || {}) : {};

        const avgPrice        = line?.avg_price_target > 0 ? Number(line.avg_price_target) : Number(d.default_avg_price);
        const projected_units  = line ? Number(line.units_target) : 0;
        const projected_vgv    = projected_units * avgPrice;
        const realized_units   = Number(contract.realized_units    || 0);
        const realized_vgv_net  = Number(contract.realized_vgv_net  || 0);
        const realized_vgv_gross = Number(contract.realized_vgv_gross || 0);

        const is_future_month = ym > todayYM;
        // achievement sempre baseado em VGV net
        const achievement_pct = projected_vgv > 0
          ? parseFloat(((realized_vgv_net / projected_vgv) * 100).toFixed(2))
          : 0;

        return { year_month: ym, projected_units, projected_vgv, realized_units, realized_vgv_net, realized_vgv_gross, achievement_pct, is_future_month };
      });

      // Summary do empreendimento (acumulado no período)
      const totalProjectedUnits  = monthsData.reduce((s, m) => s + m.projected_units,   0);
      const totalRealizedUnits   = monthsData.reduce((s, m) => s + m.realized_units,    0);
      const totalProjectedVgv    = monthsData.reduce((s, m) => s + m.projected_vgv,     0);
      const totalRealizedVgvNet  = monthsData.reduce((s, m) => s + m.realized_vgv_net,  0);
      const totalRealizedVgvGross = monthsData.reduce((s, m) => s + m.realized_vgv_gross, 0);

      // achievement_pct sempre por VGV net
      const achievement_pct = totalProjectedVgv > 0
        ? parseFloat(((totalRealizedVgvNet / totalProjectedVgv) * 100).toFixed(2))
        : 0;

      // performance_ratio: compara atingimento com % do tempo decorrido
      const performance_ratio = (timeElapsedPct > 0 && totalProjectedVgv > 0)
        ? parseFloat((achievement_pct / timeElapsedPct).toFixed(4))
        : null;

      // Status baseado em VGV net
      let status;
      if (totalProjectedVgv === 0) {
        status = 'no_projection';
      } else if (totalRealizedVgvNet === 0) {
        status = 'no_sales';
      } else if (performance_ratio === null) {
        status = 'on_track';
      } else if (performance_ratio >= 1.1) {
        status = 'ahead';
      } else if (performance_ratio >= 0.8) {
        status = 'on_track';
      } else if (performance_ratio >= 0.4) {
        status = 'behind';
      } else {
        status = 'at_risk';
      }

      enterprisesMap.set(key, {
        enterprise_key: ek,
        alias_id: aid,
        erp_id: erp,
        name,
        city,
        months: monthsData,
        summary: {
          projected_units:     totalProjectedUnits,
          realized_units:      totalRealizedUnits,
          projected_vgv:       totalProjectedVgv,
          realized_vgv_net:    totalRealizedVgvNet,
          realized_vgv_gross:  totalRealizedVgvGross,
          // compat: realized_vgv aponta para net (usado no sort padrão)
          realized_vgv:        totalRealizedVgvNet,
          achievement_pct,
          performance_ratio,
          status,
        },
      });
    }

    const enterprises = [...enterprisesMap.values()].sort((a, b) =>
      (b.summary.realized_vgv) - (a.summary.realized_vgv)
    );

    // ── Summary global ────────────────────────────────────────────────────────
    const totalProjectedVgv    = enterprises.reduce((s, e) => s + e.summary.projected_vgv,      0);
    const totalRealizedVgvNet  = enterprises.reduce((s, e) => s + e.summary.realized_vgv_net,   0);
    const totalRealizedVgvGross = enterprises.reduce((s, e) => s + e.summary.realized_vgv_gross, 0);
    const totalProjectedUnits  = enterprises.reduce((s, e) => s + e.summary.projected_units,    0);
    const totalRealizedUnits   = enterprises.reduce((s, e) => s + e.summary.realized_units,     0);
    const achievement_pct      = totalProjectedVgv > 0
      ? parseFloat(((totalRealizedVgvNet / totalProjectedVgv) * 100).toFixed(2))
      : 0;

    const summary = {
      projected_units:       totalProjectedUnits,
      realized_units:        totalRealizedUnits,
      projected_vgv:         totalProjectedVgv,
      realized_vgv_net:      totalRealizedVgvNet,
      realized_vgv_gross:    totalRealizedVgvGross,
      // compat
      realized_vgv:          totalRealizedVgvNet,
      achievement_pct,
      enterprises_total:     enterprises.length,
      enterprises_ahead:     enterprises.filter(e => e.summary.status === 'ahead').length,
      enterprises_on_track:  enterprises.filter(e => e.summary.status === 'on_track').length,
      enterprises_behind:    enterprises.filter(e => e.summary.status === 'behind').length,
      enterprises_at_risk:   enterprises.filter(e => e.summary.status === 'at_risk').length,
      enterprises_no_sales:  enterprises.filter(e => ['no_sales','no_projection'].includes(e.summary.status)).length,
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
      enterprises,
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
    const isAdmin = req.user?.role === 'admin';
    const userCity = (req.user?.city || '').trim();

    // Admin pode filtrar por cidade via query ?city=...
    const requestedCity = (req.query.city || '').trim();
    const effectiveCity = isAdmin ? requestedCity : userCity;

    if (!isAdmin && !effectiveCity) {
      return res.status(400).json({ error: 'Cidade do usuário ausente no token.' });
    }

    const whereCity =
      !effectiveCity
        ? ''
        : `AND ${CITY_EQ(`COALESCE(ec.city_override, ec.default_city)`)} = ${CITY_EQ(`:effectiveCity`)}`;

    // ✅ name volta "como antes" (com ERP embutido)
    // ✅ city volta junto pro front poder usar se quiser
    const sql = `
      SELECT DISTINCT ON (ec.erp_id)
        ec.erp_id AS id,
        (TRIM(COALESCE(ec.enterprise_name, ec.erp_id)) || ' (ERP ' || ec.erp_id || ')') AS name,
        TRIM(COALESCE(ec.city_override, ec.default_city)) AS city
      FROM enterprise_cities ec
      WHERE ec.erp_id IS NOT NULL
        ${whereCity}
      ORDER BY ec.erp_id, ec.updated_at DESC, TRIM(COALESCE(ec.enterprise_name, ec.erp_id));
    `;

    const rows = await db.sequelize.query(sql, {
      replacements: effectiveCity ? { effectiveCity } : {},
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


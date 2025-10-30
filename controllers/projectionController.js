import db from '../models/sequelize/index.js';

const { SalesProjection, SalesProjectionLine, SalesProjectionLog, SalesProjectionEnterprise, EnterpriseCity, Sequelize } = db;
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

// GET /api/projections?year=2025&only_active=1
export async function listProjections(req, res) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });

    const { year, only_active } = req.query;
    const isAdmin = req.user.role === 'admin';
    const userCity = (req.user.city || '').trim();

    const where = {};
    if (year) where.year = Number(year);
    if (only_active) where.is_active = true;

    // Admin vê tudo
    if (isAdmin) {
      const rows = await SalesProjection.findAll({
        where,
        attributes: ['id', 'year', 'name', 'is_locked', 'is_active', 'created_at', 'updated_at'],
        order: [
          ['is_active', 'DESC'],   // ativa primeiro
          ['updated_at', 'DESC'],  // mais recente por último update
          ['year', 'DESC'],        // depois ano desc (mantém previsível em anos diferentes)
          ['name', 'ASC'],
        ],
      });
      return res.json(rows);
    }

    if (!userCity) {
      return res.status(400).json({ error: 'Cidade do usuário ausente no token.' });
    }

    // Descobre quais projeções têm pelo menos um ERP permitido pela cidade do usuário
    const sql = `
      WITH allowed AS (
        SELECT DISTINCT ec.erp_id
        FROM enterprise_cities ec
        WHERE ec.source = 'erp'
          AND ${CITY_EQ(`COALESCE(ec.city_override, ec.default_city)`)} = ${CITY_EQ(`:userCity`)}
      ),
      visible_projections AS (
        SELECT DISTINCT spe.projection_id
        FROM sales_projection_enterprises spe
        JOIN allowed a ON a.erp_id = spe.erp_id
      )
      SELECT sp.id
      FROM sales_projections sp
      JOIN visible_projections vp ON vp.projection_id = sp.id
      ${year ? 'WHERE sp.year = :year' : ''}
      ${only_active ? (year ? 'AND sp.is_active = true' : 'WHERE sp.is_active = true') : ''}
    `;

    const idsRows = await db.sequelize.query(sql, {
      replacements: { userCity, year: Number(year) || null },
      type: db.Sequelize.QueryTypes.SELECT,
    });

    const ids = idsRows.map(r => r.id);
    if (!ids.length) return res.json([]);

    const rows = await SalesProjection.findAll({
      where: { ...where, id: { [Op.in]: ids } },
      attributes: ['id', 'year', 'name', 'is_locked', 'is_active', 'created_at', 'updated_at'],
      order: [
        ['is_active', 'DESC'],   // ativa primeiro
        ['updated_at', 'DESC'],  // mais recente update
        ['year', 'DESC'],
        ['name', 'ASC'],
      ],
    });

    return res.json(rows);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro ao listar projeções.' });
  }
}

// POST /api/projections  (admin)
export async function createProjection(req, res) {
  const deny = assertAdmin(req, res);
  if (deny) return;

  try {
    const { year, name, is_active } = req.body;
    if (!year || !name) return res.status(400).json({ error: 'Informe year e name.' });

    const trx = await db.sequelize.transaction();

    // cria SEMPRE desbloqueada; ativa conforme flag (normalmente false)
    const created = await SalesProjection.create({
      year: Number(year),
      name: String(name),
      is_locked: false,
      is_active: !!is_active,
      created_by: req.user.id
    }, { transaction: trx });

    // se ficou ativa, desativar as demais do mesmo ano
    if (created.is_active) {
      await SalesProjection.update(
        { is_active: false },
        { where: { year: created.year, id: { [Op.ne]: created.id } }, transaction: trx }
      );
    }

    await SalesProjectionLog.create({
      projection_id: created.id,
      action: 'CREATED',
      user_id: req.user.id,
      payload_after: { id: created.id, year: created.year, name: created.name, is_active: created.is_active }
    }, { transaction: trx });

    await trx.commit();
    return res.status(201).json({
      id: created.id, year: created.year, name: created.name,
      is_locked: created.is_locked, is_active: created.is_active
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro ao criar projeção.' });
  }
}
// POST /api/projections/clone  (admin) — clona lines + defaults da fonte
export async function cloneProjection(req, res) {
  const deny = assertAdmin(req, res);
  if (deny) return;

  const trx = await db.sequelize.transaction();
  try {
    const { source_id, year, name, is_active } = req.body;
    if (!source_id || !year || !name) {
      await trx.rollback();
      return res.status(400).json({ error: 'Informe source_id, year e name.' });
    }

    const source = await SalesProjection.findByPk(Number(source_id), { transaction: trx });
    if (!source || !source.is_active) {
      await trx.rollback();
      return res.status(400).json({ error: 'Projeção de origem inválida ou não está ativa.' });
    }

    // cria nova projeção INICIALMENTE desbloqueada; ativa conforme flag
    const created = await SalesProjection.create({
      year: Number(year),
      name: String(name),
      is_locked: false,
      is_active: !!is_active, // geralmente false por padrão
      created_by: req.user.id
    }, { transaction: trx });

    // copiar defaults
    const srcDefaults = await SalesProjectionEnterprise.findAll({
      where: { projection_id: source.id }, transaction: trx
    });
    if (srcDefaults.length) {
      const toInsert = srcDefaults.map(d => ({
        projection_id: created.id,
        erp_id: d.erp_id,
        alias_id: d.alias_id || 'default',
        default_avg_price: Number(d.default_avg_price || 0),
        enterprise_name_cache: d.enterprise_name_cache || null
      }));
      await SalesProjectionEnterprise.bulkCreate(toInsert, { transaction: trx });
    }

    // copiar lines
    const srcLines = await SalesProjectionLine.findAll({
      where: { projection_id: source.id }, transaction: trx
    });
    if (srcLines.length) {
      const toInsert = srcLines.map(l => ({
        projection_id: created.id,
        erp_id: l.erp_id,
        alias_id: l.alias_id || 'default',
        year_month: l.year_month,
        units_target: Number(l.units_target || 0),
        avg_price_target: Number(l.avg_price_target || 0),
        enterprise_name_cache: l.enterprise_name_cache || null
      }));
      await SalesProjectionLine.bulkCreate(toInsert, { transaction: trx });
    }

    // se ativou, desativar outras do mesmo ano
    if (created.is_active) {
      await SalesProjection.update(
        { is_active: false },
        { where: { year: created.year, id: { [Op.ne]: created.id } }, transaction: trx }
      );
    }

    await SalesProjectionLog.create({
      projection_id: created.id,
      action: 'CLONED',
      user_id: req.user.id,
      payload_after: { from: source.id, new_id: created.id, copied_defaults: srcDefaults.length, copied_lines: srcLines.length, is_active: created.is_active }
    }, { transaction: trx });

    await trx.commit();
    return res.status(201).json({
      id: created.id, year: created.year, name: created.name,
      is_locked: created.is_locked, is_active: created.is_active
    });
  } catch (e) {
    console.error(e);
    await trx.rollback();
    return res.status(400).json({ error: e.message || 'Erro ao clonar projeção.' });
  }
}

// GET /api/projections/:id  (linhas + filtro por cidade para não-admin) 
export async function getProjectionDetail(req, res) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido.' });

    const proj = await SalesProjection.findByPk(id, {
      attributes: ['id', 'year', 'name', 'is_locked', 'is_active', 'created_at', 'updated_at']
    });
    if (!proj) return res.status(404).json({ error: 'Projeção não encontrada.' });

    const isAdmin = req.user.role === 'admin';
    if (isAdmin) {
      // Admin: mantém seu findAll atual (sem filtro)
      const [lines, defaults] = await Promise.all([
        SalesProjectionLine.findAll({
          where: { projection_id: id },
          attributes: [
            'id', 'erp_id', 'alias_id',
            'year_month', 'units_target', 'avg_price_target',
            'enterprise_name_cache', 'created_at', 'updated_at'
          ],
          order: [['erp_id', 'ASC'], ['alias_id', 'ASC'], ['year_month', 'ASC']]
        }),
        SalesProjectionEnterprise.findAll({
          where: { projection_id: id },
          attributes: ['erp_id', 'alias_id', 'default_avg_price', 'enterprise_name_cache'],
          order: [['erp_id', 'ASC'], ['alias_id', 'ASC']]
        }),
      ]);
      return res.json({ projection: proj, lines, enterprise_defaults: defaults });
    }

    // Não-admin
    const userCity = (req.user.city || '').trim();
    if (!userCity) {
      return res.status(400).json({ error: 'Cidade do usuário ausente no token.' });
    }

    // 🔽 Filtra no SQL as linhas/defaults APENAS de ERPs da cidade do usuário
    const sqlLines = `
      WITH allowed AS (
        SELECT DISTINCT ec.erp_id
        FROM enterprise_cities ec
        WHERE ec.source = 'erp'
          AND ${CITY_EQ(`COALESCE(ec.city_override, ec.default_city)`)} = ${CITY_EQ(`:userCity`)}
      )
      SELECT
        l.id, l.erp_id, l.alias_id, l.year_month,
        l.units_target, l.avg_price_target,
        l.enterprise_name_cache, l.created_at, l.updated_at
      FROM sales_projection_lines l
      JOIN allowed a ON a.erp_id = l.erp_id
      WHERE l.projection_id = :pid
      ORDER BY l.erp_id ASC, l.alias_id ASC, l.year_month ASC;
    `;

    const sqlDefaults = `
      WITH allowed AS (
        SELECT DISTINCT ec.erp_id
        FROM enterprise_cities ec
        WHERE ec.source = 'erp'
          AND ${CITY_EQ(`COALESCE(ec.city_override, ec.default_city)`)} = ${CITY_EQ(`:userCity`)}
      )
      SELECT
        d.erp_id, d.alias_id, d.default_avg_price, d.enterprise_name_cache
      FROM sales_projection_enterprises d
      JOIN allowed a ON a.erp_id = d.erp_id
      WHERE d.projection_id = :pid
      ORDER BY d.erp_id ASC, d.alias_id ASC;
    `;

    const [lines, defaults] = await Promise.all([
      db.sequelize.query(sqlLines, {
        replacements: { pid: id, userCity },
        type: db.Sequelize.QueryTypes.SELECT,
      }),
      db.sequelize.query(sqlDefaults, {
        replacements: { pid: id, userCity },
        type: db.Sequelize.QueryTypes.SELECT,
      })
    ]);

    return res.json({ projection: proj, lines, enterprise_defaults: defaults });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro ao carregar projeção.' });
  }
}

// PUT /api/projections/:id/defaults  (admin)
export async function upsertProjectionDefaults(req, res) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }
  const trx = await db.sequelize.transaction();
  try {
    const id = Number(req.params.id);
    let { items, remove_missing } = req.body; // remove_missing opcional (boolean)
    remove_missing = !!remove_missing;

    if (!Array.isArray(items) || !items.length) {
      await trx.rollback();
      return res.status(400).json({ error: 'Envie items com pelo menos um item.' });
    }

    // normaliza entrada
    const incoming = items.map(i => ({
      projection_id: id,
      erp_id: String(i.erp_id),
      alias_id: i.alias_id ? String(i.alias_id) : 'default',
      default_avg_price: Number(i.default_avg_price ?? 0),
      enterprise_name_cache: i.enterprise_name_cache || null
    }));

    // carrega antes
    const before = await db.SalesProjectionEnterprise.findAll({
      where: { projection_id: id },
      transaction: trx
    });

    const key = r => `${r.erp_id}|${r.alias_id || 'default'}`;
    const beforeMap = new Map(before.map(r => [key(r), r.toJSON()]));
    const afterMap = new Map(incoming.map(r => [key(r), r]));

    // upsert
    await db.SalesProjectionEnterprise.bulkCreate(incoming, {
      transaction: trx,
      updateOnDuplicate: ['default_avg_price', 'enterprise_name_cache', 'updated_at']
    });

    // remoção opcional
    let removedKeys = [];
    if (remove_missing) {
      const incomingKeys = new Set(incoming.map(r => key(r)));
      const toRemove = before.filter(r => !incomingKeys.has(key(r)));
      if (toRemove.length) {
        removedKeys = toRemove.map(r => key(r));
        const ids = toRemove.map(r => r.id);
        await db.SalesProjectionEnterprise.destroy({
          where: { id: ids },
          transaction: trx
        });
      }
    }

    // resumo amigável
    const { summary, note } = summarizeDefaultsChange({ beforeMap, afterMap, removedKeys });

    await db.SalesProjectionLog.create({
      projection_id: id,
      action: 'UPSERT_DEFAULTS',
      user_id: req.user.id,
      payload_after: {
        count: incoming.length,
        remove_missing,
        summary
      },
      note
    }, { transaction: trx });

    await trx.commit();
    return res.json({ ok: true, upserted: incoming.length, removed: removedKeys.length, summary });
  } catch (e) {
    await trx.rollback();
    return res.status(400).json({ error: e.message || 'Erro ao salvar defaults.' });
  }
}

// PUT /api/projections/:id/lines  (bulk upsert – admin)
export async function upsertProjectionLines(req, res) {
  const deny = assertAdmin(req, res);
  if (deny) return;

  const trx = await db.sequelize.transaction();
  try {
    const id = Number(req.params.id);
    const { rows } = req.body;

    const proj = await db.SalesProjection.findByPk(id, { transaction: trx });
    if (!proj) { await trx.rollback(); return res.status(404).json({ error: 'Projeção não encontrada.' }); }
    if (proj.is_locked) { await trx.rollback(); return res.status(423).json({ error: 'Projeção bloqueada.' }); }

    if (!Array.isArray(rows) || !rows.length) {
      await trx.rollback();
      return res.status(400).json({ error: 'Envie rows com pelo menos um item.' });
    }

    const key = r => `${id}|${String(r.erp_id)}|${String(r.alias_id || 'default')}|${String(r.year_month).slice(0, 7)}`;
    const map = new Map();

    for (const r of rows) {
      const ym = String(r.year_month || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error(`year_month inválido: ${r.year_month}`);

      map.set(key({ ...r, year_month: ym }), {
        projection_id: id,
        erp_id: String(r.erp_id),
        alias_id: r.alias_id ? String(r.alias_id) : 'default',
        year_month: ym,
        units_target: Math.max(0, parseInt(r.units_target ?? 0, 10)),
        avg_price_target: Number(r.avg_price_target ?? 0),
        enterprise_name_cache: r.enterprise_name_cache || null
      });
    }

    const normalized = [...map.values()];

    // === métricas "antes" (somente nas chaves tocadas) ===
    const whereTouched = {
      projection_id: id,
      [db.Sequelize.Op.or]: normalized.map(n => ({
        erp_id: n.erp_id, alias_id: n.alias_id, year_month: n.year_month
      }))
    };
    const beforeTouched = await db.SalesProjectionLine.findAll({ where: whereTouched, transaction: trx });

    const beforeTotals = beforeTouched.reduce((acc, r) => {
      const u = Number(r.units_target || 0);
      const p = Number(r.avg_price_target || 0);
      acc.units += u;
      acc.revenue += (u * p);
      return acc;
    }, { units: 0, revenue: 0 });

    await db.SalesProjectionLine.bulkCreate(normalized, {
      transaction: trx,
      updateOnDuplicate: ['units_target', 'avg_price_target', 'enterprise_name_cache', 'updated_at']
    });

    const afterTouched = await db.SalesProjectionLine.findAll({ where: whereTouched, transaction: trx });
    const afterTotals = afterTouched.reduce((acc, r) => {
      const u = Number(r.units_target || 0);
      const p = Number(r.avg_price_target || 0);
      acc.units += u;
      acc.revenue += (u * p);
      return acc;
    }, { units: 0, revenue: 0 });

    const enterprisesAffected = new Set(normalized.map(n => `${n.erp_id}|${n.alias_id}`)).size;
    const monthsAffected = new Set(normalized.map(n => n.year_month)).size;

    const { summary, note } = summarizeLinesChange({
      beforeTotals, afterTotals, enterprisesAffected, monthsAffected
    });

    await db.SalesProjectionLog.create({
      projection_id: id,
      action: 'UPSERT_LINES',
      user_id: req.user.id,
      payload_after: { count: normalized.length, summary },
      note
    }, { transaction: trx });

    await trx.commit();
    return res.json({ ok: true, upserted: normalized.length, summary });
  } catch (e) {
    console.error(e);
    await trx.rollback();
    return res.status(400).json({ error: e.message || 'Erro ao salvar linhas.' });
  }
}

// PATCH /api/projections/:id  (name, is_locked, is_active) — admin
export async function updateProjectionMeta(req, res) {
  const deny = assertAdmin(req, res);
  if (deny) return;

  const trx = await db.sequelize.transaction();
  try {
    const id = Number(req.params.id);
    const { name, is_locked, is_active } = req.body;

    const proj = await SalesProjection.findByPk(id, { transaction: trx });
    if (!proj) { await trx.rollback(); return res.status(404).json({ error: 'Projeção não encontrada.' }); }

    const before = proj.toJSON();
    const changes = {};

    if (typeof name !== 'undefined' && name !== proj.name) {
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

    // se ficou ativa, desativar demais do mesmo ano
    if (typeof is_active !== 'undefined' && proj.is_active) {
      await SalesProjection.update(
        { is_active: false },
        { where: { year: proj.year, id: { [Op.ne]: proj.id } }, transaction: trx }
      );
    }

    const parts = [];
    if (changes.name) parts.push(`nome: "${changes.name.from}" → "${changes.name.to}"`);
    if (changes.is_locked) parts.push(`status: ${changes.is_locked.from ? 'Bloqueada' : 'Aberta'} → ${changes.is_locked.to ? 'Bloqueada' : 'Aberta'}`);
    if (changes.is_active) parts.push(`ativa: ${changes.is_active.from ? 'Sim' : 'Não'} → ${changes.is_active.to ? 'Sim' : 'Não'}`);
    const note = parts.length ? `Meta alterada: ${parts.join(' • ')}.` : 'Meta: nenhuma alteração.';

    await SalesProjectionLog.create({
      projection_id: id,
      action: (typeof is_locked !== 'undefined')
        ? (proj.is_locked ? 'LOCKED' : 'UNLOCKED')
        : (typeof is_active !== 'undefined' ? (proj.is_active ? 'ACTIVATED' : 'DEACTIVATED') : 'UPDATED_META'),
      user_id: req.user.id,
      payload_before: before,
      payload_after: proj.toJSON(),
      note
    }, { transaction: trx });

    await trx.commit();
    return res.json({ id: proj.id, year: proj.year, name: proj.name, is_locked: proj.is_locked, is_active: proj.is_active });
  } catch (e) {
    console.error(e);
    await trx.rollback();
    return res.status(400).json({ error: e.message || 'Erro ao atualizar projeção.' });
  }
}
// GET /api/projections/:id/logs 
export async function getProjectionLogs(req, res) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });

    const id = Number(req.params.id);
    const logs = await db.SalesProjectionLog.findAll({
      where: { projection_id: id },
      order: [['created_at', 'DESC']],
      attributes: ['id', 'action', 'user_id', 'payload_before', 'payload_after', 'note', 'created_at'],
      include: [
        { model: db.User, as: 'actor', attributes: ['id', 'username', 'email'] }
      ]
    });

    return res.json(logs);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro ao listar logs.' });
  }
}

export async function listEnterprisesForPicker(req, res) {
  try {
    const isAdmin = req.user?.role === 'admin';
    const userCity = req.user?.city || '';

    // Base: enterprise_cities como “fonte de verdade”
    // DISTINCT ON (erp_id) escolhe um nome estável; prioriza override mais recente
    const sql = `
      SELECT DISTINCT ON (ec.erp_id)
             ec.erp_id                          AS id,
             TRIM(COALESCE(ec.enterprise_name, ec.erp_id)) AS name
      FROM enterprise_cities ec
      WHERE
        ec.erp_id IS NOT NULL
        ${(isAdmin ? '' : `
          AND unaccent(upper(regexp_replace(COALESCE(ec.city_override, ec.default_city), '[^A-Z0-9]+',' ','g'))) =
              unaccent(upper(regexp_replace(:userCity, '[^A-Z0-9]+',' ','g')))
        `)}
      ORDER BY ec.erp_id, ec.updated_at DESC, TRIM(COALESCE(ec.enterprise_name, ec.erp_id));
    `;

    const rows = await db.sequelize.query(sql, {
      replacements: isAdmin ? {} : { userCity },
      type: db.Sequelize.QueryTypes.SELECT
    });

    // Defesa extra: colapsa por id no Node (caso algo escape).
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

function summarizeDefaultsChange({ beforeMap, afterMap, removedKeys }) {
  const added = [];
  const removed = [];
  const price_changed = [];
  const renamed = [];

  // added & updated
  for (const [k, v] of afterMap.entries()) {
    const prev = beforeMap.get(k);
    if (!prev) {
      added.push({ erp_id: v.erp_id, alias_id: v.alias_id });
    } else {
      const pFrom = Number(prev.default_avg_price || 0);
      const pTo = Number(v.default_avg_price || 0);
      if (pFrom !== pTo) {
        price_changed.push({
          erp_id: v.erp_id,
          alias_id: v.alias_id,
          from: pFrom,
          to: pTo
        });
      }
      const nFrom = prev.enterprise_name_cache || null;
      const nTo = v.enterprise_name_cache || null;
      if (nFrom !== nTo) {
        renamed.push({
          erp_id: v.erp_id,
          alias_id: v.alias_id,
          from: nFrom,
          to: nTo
        });
      }
    }
  }

  // removed
  for (const k of removedKeys) {
    const prev = beforeMap.get(k);
    if (prev) {
      removed.push({ erp_id: prev.erp_id, alias_id: prev.alias_id });
    }
  }

  const noteParts = [];
  if (added.length) noteParts.push(`${added.length} adicionado(s)`);
  if (removed.length) noteParts.push(`${removed.length} removido(s)`);
  if (price_changed.length) noteParts.push(`${price_changed.length} preço(s) alterado(s)`);
  if (renamed.length) noteParts.push(`${renamed.length} renomeado(s)`);

  const note = noteParts.length ? `Defaults: ${noteParts.join(', ')}.` : 'Defaults: nenhuma mudança relevante.';
  return {
    summary: { added, removed, price_changed, renamed },
    note
  };
}

function summarizeLinesChange({ beforeTotals, afterTotals, enterprisesAffected, monthsAffected }) {
  const unitsDelta = Number(afterTotals.units) - Number(beforeTotals.units);
  const revenueDelta = Number(afterTotals.revenue) - Number(beforeTotals.revenue);

  const note = [
    'Linhas:',
    `${enterprisesAffected} empreendimento(s) afetado(s)`,
    `${monthsAffected} mês(es) tocado(s)`,
    `Δ unidades = ${unitsDelta}`,
    `Δ receita = R$ ${revenueDelta.toFixed(2)}`
  ].join(' • ');

  return {
    summary: {
      enterprises_affected: enterprisesAffected,
      months_affected: monthsAffected,
      units_delta: unitsDelta,
      revenue_delta: Number(revenueDelta.toFixed(2))
    },
    note
  };
}



import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

function normStr(v) {
  return String(v ?? '').trim();
}

function toUpper(v, fallback = '') {
  const s = normStr(v);
  return s ? s.toUpperCase() : fallback;
}

function slugify(input) {
  return normStr(input)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
}

async function ensureUniqueSlug(base) {
  let b = normStr(base);
  if (!b) b = `trilha-${Date.now()}`;

  let slug = b;
  let i = 0;
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await db.AcademyTrack.findOne({ where: { slug } });
    if (!exists) return slug;
    i += 1;
    slug = `${b}-${i}`;
  }
}

async function ensureTrack(slugOrId) {
  const raw = normStr(slugOrId);
  if (!raw) throw new Error('Trilha não encontrada.');

  // 1) por slug
  const bySlug = await db.AcademyTrack.findOne({ where: { slug: raw } });
  if (bySlug) return bySlug;

  // 2) fallback por id (caso front mande id)
  const maybeId = Number(raw);
  if (Number.isFinite(maybeId) && maybeId > 0) {
    const byId = await db.AcademyTrack.findByPk(maybeId);
    if (byId) return byId;
  }

  throw new Error('Trilha não encontrada.');
}

function normalizeStatus(v) {
  const s = toUpper(v, 'DRAFT');
  return ['DRAFT', 'PUBLISHED'].includes(s) ? s : 'DRAFT';
}

// Mantido por compatibilidade (se você ainda tem coluna audience).
// Se não tiver, nada aqui quebra (só não use).
function normalizeAudience(v) {
  const s = toUpper(v, 'BOTH');
  return ['BOTH', 'GESTOR_ONLY', 'ADM_ONLY'].includes(s) ? s : 'BOTH';
}

function normalizeItemType(v) {
  const t = toUpper(v, 'TASK');
  const allowed = ['TEXT', 'VIDEO', 'QUIZ', 'ARTICLE', 'COMMUNITY_TOPIC', 'LINK', 'TASK', 'FORM'];
  if (!allowed.includes(t)) throw new Error('Tipo de item inválido.');
  return t;
}

function asJsonOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v;
  throw new Error('payload inválido (deve ser objeto).');
}

async function nextOrderIndex(trackId) {
  const max = await db.AcademyTrackItem.max('orderIndex', { where: { trackId } });
  const m = Number(max);
  return Number.isFinite(m) && m > 0 ? m + 1 : 1;
}

async function getItems(trackId) {
  const items = await db.AcademyTrackItem.findAll({
    where: { trackId },
    attributes: [
      'id',
      'trackId',
      'orderIndex',
      'type',
      'title',
      'target',
      'content',
      'payload',
      'estimatedMinutes',
      'required',
      'createdAt',
      'updatedAt',
    ],
    order: [['orderIndex', 'ASC']],
  });
  return items.map((i) => i.toJSON());
}

const trackAdminService = {
  // Admin list
  async list({ audience = 'BOTH', status = '' } = {}) {
    const where = {};
    const s = toUpper(status, '');
    if (s) where.status = normalizeStatus(s);

    // Se você ainda usa audience no banco
    const a = normalizeAudience(audience);
    if (a) where.audience = a;

    const rows = await db.AcademyTrack.findAll({
      where,
      attributes: ['id', 'slug', 'title', 'description', 'status', 'audience', 'updatedAt', 'createdAt'],
      order: [['updatedAt', 'DESC']],
    });

    return { results: rows.map((r) => r.toJSON()) };
  },

  // Admin detail
  async get({ slug } = {}) {
    const track = await ensureTrack(slug);

    const items = await getItems(track.id);

    // total estimado (minutos). Recomendo somar só required, mas aqui soma tudo.
    const totalMinutes = items.reduce((acc, it) => acc + (Number(it.estimatedMinutes) || 0), 0);

    return {
      track: track.toJSON(),
      items,
      totalMinutes,
    };
  },

  // Create track (slug sempre gerado)
  async create({ payload } = {}) {
    const title = normStr(payload?.title);
    if (!title) throw new Error('Título é obrigatório.');

    const description = normStr(payload?.description);
    const status = normalizeStatus(payload?.status || 'DRAFT');

    // audience opcional
    const audience = normalizeAudience(payload?.audience || 'BOTH');

    const typedSlug = normStr(payload?.slug);
    const base = slugify(typedSlug || title);
    const slug = await ensureUniqueSlug(base);

    const created = await db.AcademyTrack.create({
      slug,
      title,
      description,
      status,
      audience,
    });

    return { track: created.toJSON() };
  },

  async update({ slug, payload } = {}) {
    const track = await ensureTrack(slug);

    const title = payload?.title !== undefined ? normStr(payload?.title) : undefined;
    if (payload?.title !== undefined && !title) throw new Error('Título é obrigatório.');

    const description = payload?.description !== undefined ? normStr(payload?.description) : undefined;
    const status = payload?.status !== undefined ? normalizeStatus(payload?.status) : undefined;
    const audience = payload?.audience !== undefined ? normalizeAudience(payload?.audience) : undefined;

    if (title !== undefined) track.title = title;
    if (description !== undefined) track.description = description;
    if (status !== undefined) track.status = status;
    if (audience !== undefined) track.audience = audience;

    await track.save();
    return { track: track.toJSON() };
  },

  async setPublish({ slug, publish } = {}) {
    const track = await ensureTrack(slug);
    track.status = publish ? 'PUBLISHED' : 'DRAFT';
    await track.save();
    return { track: track.toJSON() };
  },

  // Add item (entra no final se não passar orderIndex)
  async addItem({ slug, payload } = {}) {
    const track = await ensureTrack(slug);

    const type = normalizeItemType(payload?.type);
    const title = normStr(payload?.title);
    if (!title) throw new Error('Título é obrigatório.');

    const target = normStr(payload?.target); // pode ficar vazio (ARTICLE/COMMUNITY podem usar payload)
    const content = payload?.content !== undefined ? normStr(payload?.content) : null;
    const itemPayload = payload?.payload !== undefined ? asJsonOrNull(payload?.payload) : null;

    const estimatedMinutes = Math.max(0, Number(payload?.estimatedMinutes || 0));
    const required = payload?.required === false ? false : true;

    const orderIndex =
      payload?.orderIndex !== undefined
        ? Math.max(1, Number(payload?.orderIndex || 1))
        : await nextOrderIndex(track.id);

    const created = await db.AcademyTrackItem.create({
      trackId: track.id,
      orderIndex,
      type,
      title,
      target,
      content: content || null,
      payload: itemPayload,
      estimatedMinutes,
      required,
    });

    return { item: created.toJSON() };
  },

  async updateItem({ slug, itemId, payload } = {}) {
    const track = await ensureTrack(slug);

    const id = Number(itemId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('Item inválido.');

    const item = await db.AcademyTrackItem.findOne({ where: { id, trackId: track.id } });
    if (!item) throw new Error('Item não encontrado.');

    if (payload?.type !== undefined) item.type = normalizeItemType(payload.type);

    if (payload?.title !== undefined) {
      const title = normStr(payload.title);
      if (!title) throw new Error('Título é obrigatório.');
      item.title = title;
    }

    if (payload?.target !== undefined) item.target = normStr(payload.target);

    if (payload?.content !== undefined) {
      const c = normStr(payload.content);
      item.content = c ? c : null;
    }

    if (payload?.payload !== undefined) item.payload = asJsonOrNull(payload.payload);

    if (payload?.estimatedMinutes !== undefined) {
      item.estimatedMinutes = Math.max(0, Number(payload.estimatedMinutes || 0));
    }

    if (payload?.required !== undefined) item.required = !!payload.required;

    if (payload?.orderIndex !== undefined) {
      item.orderIndex = Math.max(1, Number(payload.orderIndex || 1));
    }

    await item.save();
    return { item: item.toJSON() };
  },

  async removeItem({ slug, itemId } = {}) {
    const track = await ensureTrack(slug);

    const id = Number(itemId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('Item inválido.');

    const item = await db.AcademyTrackItem.findOne({ where: { id, trackId: track.id } });
    if (!item) throw new Error('Item não encontrado.');

    await item.destroy();
    return { ok: true };
  },

  // order = [12,10,11] (ids). Vai aplicar orderIndex 1..N
  async reorder({ slug, order } = {}) {
    const track = await ensureTrack(slug);

    const ids = Array.isArray(order)
      ? order.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
      : [];

    if (!ids.length) throw new Error('Ordem inválida.');

    const rows = await db.AcademyTrackItem.findAll({
      where: { trackId: track.id, id: { [Op.in]: ids } },
      attributes: ['id'],
      raw: true,
    });

    if (rows.length !== ids.length) throw new Error('Ordem contém itens que não pertencem à trilha.');

    // transação simples
    await db.sequelize.transaction(async (t) => {
      for (let i = 0; i < ids.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await db.AcademyTrackItem.update(
          { orderIndex: i + 1 },
          { where: { id: ids[i], trackId: track.id }, transaction: t }
        );
      }
    });

    return { ok: true };
  },

  async remove({ slug } = {}) {
    const track = await ensureTrack(slug);

    // Validação 1: não deixa excluir se tiver progresso
    // (model pode existir com nomes diferentes; ajuste se necessário)
    const progressCount =
      (db.AcademyUserTrackProgress
        ? await db.AcademyUserTrackProgress.count({ where: { trackSlug: track.slug } })
        : 0) +
      (db.AcademyUserProgress
        ? await db.AcademyUserProgress.count({ where: { trackSlug: track.slug } })
        : 0);

    if (progressCount > 0) {
      throw new Error('Não é possível excluir: existe progresso de usuários nessa trilha.');
    }

    // Exclui itens + vínculos + trilha (transação)
    await db.sequelize.transaction(async (t) => {
      if (db.AcademyTrackItem) {
        await db.AcademyTrackItem.destroy({ where: { trackId: track.id }, transaction: t });
      }

      // Ajuste o nome do model do assignment se for diferente
      if (db.AcademyTrackAssignment) {
        await db.AcademyTrackAssignment.destroy({ where: { trackSlug: track.slug }, transaction: t });
      }

      await track.destroy({ transaction: t });
    });

    return { ok: true };
  },

};

export default trackAdminService;

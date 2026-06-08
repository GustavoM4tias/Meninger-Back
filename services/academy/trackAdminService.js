import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { normalizeAudiences, deriveLegacyAudience, DEFAULT_AUDIENCES } from './audience.js';

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
    .replace(/\p{M}/gu, '')
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

function resolveAudiencesForWrite(input) {
  const arr = normalizeAudiences(input);
  return arr.length ? arr : DEFAULT_AUDIENCES.slice();
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

// ⚠️ SEGURANÇA: garante que o artigo referenciado pelo item ARTICLE
// cobre TODAS as audiences da trilha. Caso contrário, um usuário visando
// a trilha não consegue abrir o artigo (ou pior: nem pode ver, mas vê o
// link). Lança erro 400 com a lista de tokens faltantes.
async function assertArticleCoversTrack({ track, item }) {
  if (!item || String(item.type || '').toUpperCase() !== 'ARTICLE') return;

  const target = normStr(item.target);
  if (!target) return; // sem target, não há o que validar (UI deve impedir)

  // target esperado: "kb/<category>/<slug>" — mas aceitamos só <slug> também.
  let slug = target;
  if (target.includes('/')) {
    const parts = target.split('/').filter(Boolean);
    slug = parts[parts.length - 1];
  }

  const article = await db.AcademyArticle.findOne({
    where: { slug },
    attributes: ['id', 'title', 'audiences'],
    raw: true,
  });
  if (!article) {
    throw new Error(`Artigo "${slug}" não encontrado para validar audiences do item.`);
  }

  const trackAudiences = normalizeAudiences(track.audiences);
  const articleAudiences = new Set(normalizeAudiences(article.audiences));

  const missing = trackAudiences.filter(a => !articleAudiences.has(a));
  if (missing.length) {
    throw new Error(
      `O artigo "${article.title}" não cobre o público da trilha (faltando: ${missing.join(', ')}). ` +
      `Edite o artigo e habilite esses públicos antes de vinculá-lo a esta trilha.`
    );
  }
}

const trackAdminService = {
  // Admin list
  async list({ status = '' } = {}) {
    const where = {};
    const s = toUpper(status, '');
    if (s) where.status = normalizeStatus(s);

    const rows = await db.AcademyTrack.findAll({
      where,
      attributes: ['id', 'slug', 'title', 'description', 'status', 'audience', 'audiences', 'updatedAt', 'createdAt'],
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

    const audiences = resolveAudiencesForWrite(payload?.audiences);
    const audience = deriveLegacyAudience(audiences);

    const typedSlug = normStr(payload?.slug);
    const base = slugify(typedSlug || title);
    const slug = await ensureUniqueSlug(base);

    const created = await db.AcademyTrack.create({
      slug,
      title,
      description,
      status,
      audience,
      audiences,
    });

    return { track: created.toJSON() };
  },

  async update({ slug, payload } = {}) {
    const track = await ensureTrack(slug);

    const title = payload?.title !== undefined ? normStr(payload?.title) : undefined;
    if (payload?.title !== undefined && !title) throw new Error('Título é obrigatório.');

    const description = payload?.description !== undefined ? normStr(payload?.description) : undefined;
    const status = payload?.status !== undefined ? normalizeStatus(payload?.status) : undefined;

    if (title !== undefined) track.title = title;
    if (description !== undefined) track.description = description;
    if (status !== undefined) track.status = status;

    if (payload?.audiences !== undefined) {
      const audiences = resolveAudiencesForWrite(payload.audiences);
      track.audiences = audiences;
      track.audience = deriveLegacyAudience(audiences);
    }

    await track.save();

    // 🔒 Se o admin restringiu as audiences da trilha, revalida cada ARTICLE item:
    //    cada artigo precisa cobrir todas as audiences (novas) da trilha.
    if (payload?.audiences !== undefined) {
      const items = await db.AcademyTrackItem.findAll({
        where: { trackId: track.id, type: 'ARTICLE' },
        attributes: ['id', 'type', 'target', 'title'],
        raw: true,
      });
      for (const it of items) {
        // eslint-disable-next-line no-await-in-loop
        await assertArticleCoversTrack({ track, item: it });
      }
    }

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

    // 🔒 Valida cobertura ANTES de criar — evita item órfão sem visibilidade.
    if (type === 'ARTICLE') {
      await assertArticleCoversTrack({ track, item: { type, target } });
    }

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

    // 🔒 Se passou a ser ARTICLE OU o target/type mudou, revalida cobertura.
    if (String(item.type || '').toUpperCase() === 'ARTICLE') {
      await assertArticleCoversTrack({ track, item: item.toJSON() });
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

    // detecta duplicatas no array (mesmo id repetido)
    if (new Set(ids).size !== ids.length) {
      throw new Error('Ordem contém IDs duplicados.');
    }

    // valida pertinência E completude: o array precisa cobrir TODOS os items da trilha,
    // senão items fora do array mantêm orderIndex antigo e geram colisões.
    const allRows = await db.AcademyTrackItem.findAll({
      where: { trackId: track.id },
      attributes: ['id'],
      raw: true,
    });

    const allIds = new Set(allRows.map((r) => Number(r.id)));
    if (allIds.size !== ids.length) {
      throw new Error('Ordem precisa conter todos os itens da trilha (recebido: ' + ids.length + ', esperado: ' + allIds.size + ').');
    }
    for (const id of ids) {
      if (!allIds.has(id)) throw new Error('Ordem contém item que não pertence à trilha (id ' + id + ').');
    }

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

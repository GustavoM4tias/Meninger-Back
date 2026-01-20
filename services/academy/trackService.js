import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

const DEBUG = false; // deixe false em prod
function dlog(...args) { if (DEBUG) console.log('[trackService]', ...args); }
function dwarn(...args) { console.warn('[trackService]', ...args); }

function normStr(v) {
  return String(v ?? '').trim();
}

function toUpper(v, fallback = '') {
  const s = normStr(v);
  return s ? s.toUpperCase() : fallback;
}

function toBool(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

function normalizeAudience(v) {
  const s = toUpper(v, 'BOTH');
  return ['BOTH', 'GESTOR_ONLY', 'ADM_ONLY'].includes(s) ? s : 'BOTH';
}

function audienceWhere(audience) {
  if (!audience) return {};
  return { audience };
}

function normalizeTrackStatus(percent) {
  const p = Number(percent || 0);
  if (p >= 100) return 'COMPLETED';
  if (p > 0) return 'IN_PROGRESS';
  return 'NOT_STARTED';
}

async function getUserContext(userId) {
  if (!userId) return null;

  const user = await db.User.findByPk(userId, {
    attributes: ['id', 'role', 'position', 'city'],
    raw: true,
  });

  if (!user) return null;

  let positionCode = null;
  let departmentId = null;

  if (user.position) {
    const pos = await db.Position.findOne({
      where: { active: true, name: { [Op.iLike]: user.position } },
      attributes: ['code', 'department_id'],
      raw: true,
    });

    positionCode = pos?.code ? String(pos.code) : null;
    departmentId = pos?.department_id ? String(pos.department_id) : null;
  }

  let cityId = null;
  if (user.city) {
    const c = await db.UserCity.findOne({
      where: { active: true, name: { [Op.iLike]: user.city } },
      attributes: ['id'],
      raw: true,
    });
    cityId = c?.id ? String(c.id) : null;
  }

  return {
    userId: String(user.id),
    role: String(user.role || ''),
    positionCode,
    departmentId,
    cityId,
  };
}

function isAllowedByAssignmentsRows(assignmentsForSlug, userCtx) {
  if (!assignmentsForSlug?.length) return true;
  if (!userCtx) return false;

  return assignmentsForSlug.some((r) => {
    const t = String(r.scopeType || '').toUpperCase().trim();
    const v = String(r.scopeValue || '').trim();
    if (!t || !v) return false;

    if (t === 'USER') return userCtx.userId === v;
    if (t === 'ROLE') return userCtx.role === v;
    if (t === 'POSITION') return userCtx.positionCode === v;
    if (t === 'DEPARTMENT') return userCtx.departmentId === v;
    if (t === 'CITY') return userCtx.cityId === v;

    return false;
  });
}

const trackService = {
  async listTracks({ audience = 'BOTH', userId = null } = {}) {
    const a = normalizeAudience(audience);

    const rows = await db.AcademyTrack.findAll({
      where: { status: 'PUBLISHED', ...audienceWhere(a) },
      attributes: ['slug', 'title', 'description', 'audience', 'updatedAt'],
      order: [['updatedAt', 'DESC']],
    });

    const slugs = rows.map((r) => String(r.slug));
    if (!slugs.length) return { results: [] };

    const userCtx = await getUserContext(userId);

    const assigns = await db.AcademyTrackAssignment.findAll({
      where: { trackSlug: { [Op.in]: slugs } },
      attributes: ['trackSlug', 'scopeType', 'scopeValue'],
      raw: true,
    });

    const bySlug = new Map();
    for (const aRow of assigns) {
      const s = String(aRow.trackSlug);
      if (!bySlug.has(s)) bySlug.set(s, []);
      bySlug.get(s).push(aRow);
    }

    const allowed = rows.filter((t) => {
      const s = String(t.slug);
      const list = bySlug.get(s) || [];
      return isAllowedByAssignmentsRows(list, userCtx);
    });

    let progressBySlug = new Map();

    if (userCtx?.userId && allowed.length) {
      const progRows = await db.AcademyUserTrackProgress.findAll({
        where: {
          userId: Number(userCtx.userId),
          trackSlug: { [Op.in]: allowed.map((t) => String(t.slug)) },
        },
        attributes: ['trackSlug', 'progressPercent'],
        raw: true,
      });

      progressBySlug = new Map(
        progRows.map((r) => [String(r.trackSlug), Number(r.progressPercent || 0)])
      );
    }

    const results = allowed.map((t) => {
      const slug = String(t.slug);
      return {
        ...t.toJSON(),
        progressPercent: progressBySlug.get(slug) ?? 0,
      };
    });

    return { results };
  },

  async getTrack({ slug, audience = 'BOTH', userId = null } = {}) {
    const a = normalizeAudience(audience);
    const trackSlug = String(slug || '').trim();
    if (!trackSlug) return null;

    const userCtx = await getUserContext(userId);

    const assigns = await db.AcademyTrackAssignment.findAll({
      where: { trackSlug },
      attributes: ['scopeType', 'scopeValue'],
      raw: true,
    });

    if (!isAllowedByAssignmentsRows(assigns, userCtx)) return null;

    const track = await db.AcademyTrack.findOne({
      where: { slug: trackSlug, status: 'PUBLISHED', ...audienceWhere(a) },
      attributes: ['id', 'slug', 'title', 'description', 'audience', 'updatedAt'],
    });
    if (!track) return null;

    const items = await db.AcademyTrackItem.findAll({
      where: { trackId: track.id },
      attributes: [
        'id',
        'orderIndex',
        'type',
        'title',
        'target',
        'content',
        'payload',
        'estimatedMinutes',
        'required',
      ],
      order: [['orderIndex', 'ASC']],
    });

    // progresso concluído
    let completedIds = new Set();
    if (userCtx?.userId) {
      const rows = await db.AcademyUserProgress.findAll({
        where: { userId: Number(userCtx.userId), trackSlug, completed: true },
        attributes: ['itemId'],
        raw: true,
      });
      completedIds = new Set(rows.map((r) => Number(r.itemId)));
    }

    const totalRequired = items.filter((i) => toBool(i.required)).length || 0;
    const completedRequired =
      items.filter((i) => toBool(i.required) && completedIds.has(Number(i.id))).length || 0;

    const progressPercent = totalRequired ? Math.round((completedRequired / totalRequired) * 100) : 0;

    // attempts
    let attemptsByItemId = new Map();

    if (userCtx?.userId) {
      const attempts = await db.AcademyUserQuizAttempt.findAll({
        where: { userId: Number(userCtx.userId), trackSlug },
        attributes: ['itemId', 'answers', 'allCorrect', 'submittedAt'],
        raw: true,
      });

      attemptsByItemId = new Map(
        attempts.map((aRow) => [
          Number(aRow.itemId),
          {
            answers: aRow.answers,
            allCorrect: !!aRow.allCorrect,
            submittedAt: aRow.submittedAt || null,
          },
        ])
      );

      // log só se tiver “anomalia”: tem itens quiz mas zero tentativas
      const hasQuizItems = items.some((i) => String(i.type || '').toUpperCase() === 'QUIZ');
      if (hasQuizItems && attempts.length === 0) {
        dlog('getTrack(): no quiz attempts found', { trackSlug, userId: Number(userCtx.userId) });
      }
    }

    const outItems = items.map((i) => {
      const id = Number(i.id);
      const attempt = attemptsByItemId.get(id) || null;
      return {
        ...i.toJSON(),
        completed: completedIds.has(id),
        quizAttempt: attempt,
      };
    });

    return {
      track: track.toJSON(),
      items: outItems,
      progressPercent,
    };
  },

  async markProgress({ userId, trackSlug, itemId, completed = true } = {}) {
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) throw new Error('Usuário não identificado.');

    const slug = String(trackSlug || '').trim();
    if (!slug || slug === 'undefined') throw new Error('Trilha inválida.');

    const id = Number(itemId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('Item inválido.');

    if (completed) {
      await db.AcademyUserProgress.upsert({
        userId: uid,
        trackSlug: slug,
        itemId: id,
        completed: true,
        completedAt: new Date(),
      });
    } else {
      await db.AcademyUserProgress.destroy({ where: { userId: uid, trackSlug: slug, itemId: id } });
    }

    const detail = await this.getTrack({ slug, audience: 'BOTH', userId: uid });
    const percent = Number(detail?.progressPercent ?? 0);
    const status = normalizeTrackStatus(percent);

    await db.AcademyUserTrackProgress.upsert({
      userId: uid,
      trackSlug: slug,
      status,
      progressPercent: percent,
    });

    return { ok: true, ...detail };
  },

  async submitQuizAttempt({ userId, trackSlug, itemId, answers = {}, allCorrect = false } = {}) {
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) throw new Error('Usuário não identificado.');

    const slug = String(trackSlug || '').trim();
    if (!slug || slug === 'undefined') throw new Error('Trilha inválida.');

    const id = Number(itemId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('Item inválido.');

    // log só se vier payload estranho
    if (answers == null || typeof answers !== 'object') {
      dwarn('submitQuizAttempt(): unexpected answers type', { slug, id, answersType: typeof answers });
    }

    await db.AcademyUserQuizAttempt.upsert({
      userId: uid,
      trackSlug: slug,
      itemId: id,
      answers,
      allCorrect: !!allCorrect,
      submittedAt: new Date(),
    });

    const detail = await this.getTrack({ slug, audience: 'BOTH', userId: uid });
    return { ok: true, ...detail };
  },
};

export default trackService;

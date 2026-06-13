import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';
import {
    resolveUserTokens,
    audiencesWhereLiteral,
} from './audience.js';
import certificateService from './certificateService.js';
import questionBankService from './questionBankService.js';
import prerequisiteService from './prerequisiteService.js';
import gamificationService from './gamificationService.js';

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

function normalizeTrackStatus(percent) {
  const p = Number(percent || 0);
  if (p >= 100) return 'COMPLETED';
  if (p > 0) return 'IN_PROGRESS';
  return 'NOT_STARTED';
}

// ── Quiz helpers (server-side scoring) ──────────────────────────────────────
//
// O payload de QUIZ pode vir em vários formatos:
//   - payload.quiz: { title, questions: [...] }
//   - payload.questions: [...]
//   - payload.quizzes: { key: { questions: [...] } }
//   - payload.widgets.quiz: { key: { questions: [...] } }
//   - payload.widget.quiz: { key: { questions: [...] } }
//   - payload.data.quiz: { key: { questions: [...] } }
//
// Cada questão tem: { text, options: [...], correctIndex | correct_index }.
//
// Para a rota pública (/tracks/:slug), removemos correctIndex de TODAS as
// localizações antes de devolver — senão qualquer um lê no devtools e
// "decora" a resposta. Para rotas admin (trackAdminController), preservamos.

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// Aceita correctIndex (singular, formato antigo) OU correctIndexes (array, banco S2.2).
// Retorna SEMPRE um array (mesmo para SINGLE) — facilita comparação uniforme.
function correctIndexesOf(question) {
  if (Array.isArray(question?.correctIndexes)) {
    return question.correctIndexes.map(n => Number(n)).filter(Number.isFinite);
  }
  const ci = Number(question?.correctIndex);
  if (Number.isFinite(ci)) return [ci];
  const c2 = Number(question?.correct_index);
  if (Number.isFinite(c2)) return [c2];
  return [];
}

// Compatibilidade com versões antigas que esperam um único índice.
function correctIndexOf(question) {
  const arr = correctIndexesOf(question);
  return arr.length ? arr[0] : null;
}

// Extrai todos os quizzes de um payload (qualquer formato suportado).
// Retorna array de objetos { quizRef, questions }.
function extractQuizzes(payload) {
  const out = [];
  if (!isPlainObject(payload)) return out;

  const pushQuiz = (key, quizObj) => {
    if (!isPlainObject(quizObj)) return;
    const questions = Array.isArray(quizObj.questions) ? quizObj.questions : null;
    if (!questions) return;
    out.push({ quizRef: key, questions });
  };

  // payload.quiz
  if (isPlainObject(payload.quiz)) pushQuiz('default', payload.quiz);

  // payload.questions (array direto na raiz)
  if (Array.isArray(payload.questions)) {
    out.push({ quizRef: 'default', questions: payload.questions });
  }

  // payload.quizzes
  if (isPlainObject(payload.quizzes)) {
    for (const k of Object.keys(payload.quizzes)) pushQuiz(k, payload.quizzes[k]);
  }

  // payload.widgets.quiz
  if (isPlainObject(payload.widgets?.quiz)) {
    for (const k of Object.keys(payload.widgets.quiz)) pushQuiz(k, payload.widgets.quiz[k]);
  }

  // payload.widget.quiz (variante)
  if (isPlainObject(payload.widget?.quiz)) {
    for (const k of Object.keys(payload.widget.quiz)) pushQuiz(k, payload.widget.quiz[k]);
  }

  // payload.data.quiz
  if (isPlainObject(payload.data?.quiz)) {
    for (const k of Object.keys(payload.data.quiz)) pushQuiz(k, payload.data.quiz[k]);
  }

  return out;
}

// Devolve cópia profunda do payload sem correctIndex/correct_index nas questões.
function stripQuizAnswerKeys(payload) {
  if (!isPlainObject(payload)) return payload;
  // Deep clone seguro pra JSON-only payloads.
  let clone;
  try { clone = JSON.parse(JSON.stringify(payload)); } catch { return payload; }

  const sanitizeQuestions = (qs) => {
    if (!Array.isArray(qs)) return;
    for (const q of qs) {
      if (isPlainObject(q)) {
        delete q.correctIndex;
        delete q.correct_index;
      }
    }
  };

  const sanitizeQuiz = (quizObj) => {
    if (!isPlainObject(quizObj)) return;
    sanitizeQuestions(quizObj.questions);
  };

  if (isPlainObject(clone.quiz)) sanitizeQuiz(clone.quiz);
  if (Array.isArray(clone.questions)) sanitizeQuestions(clone.questions);
  if (isPlainObject(clone.quizzes)) for (const k of Object.keys(clone.quizzes)) sanitizeQuiz(clone.quizzes[k]);
  if (isPlainObject(clone.widgets?.quiz)) for (const k of Object.keys(clone.widgets.quiz)) sanitizeQuiz(clone.widgets.quiz[k]);
  if (isPlainObject(clone.widget?.quiz)) for (const k of Object.keys(clone.widget.quiz)) sanitizeQuiz(clone.widget.quiz[k]);
  if (isPlainObject(clone.data?.quiz)) for (const k of Object.keys(clone.data.quiz)) sanitizeQuiz(clone.data.quiz[k]);

  return clone;
}

// Calcula score server-side a partir de answers do cliente.
//
// answers pode ser:
//   - { 0: 1, 1: 2 }      — quiz único, qi -> selectedIndex
//   - { default: { 0: 1, 1: 2 } } — quiz com ref
//   - { quizKey: { 0: 1 } }
//
// Retorna { totalQuestions, correctCount, allCorrect, perQuestion: [{qi, correct, expected, given}] }
function scoreQuiz({ payload, answers }) {
  const quizzes = extractQuizzes(payload);
  if (!quizzes.length) {
    return { totalQuestions: 0, correctCount: 0, allCorrect: false, perQuestion: [] };
  }

  // Resolve answers do quiz "principal" (default ou primeiro).
  // Suporta { qi: idx } direto OU { quizRef: { qi: idx } }.
  let answersForQuiz = answers;
  if (isPlainObject(answers)) {
    const firstKey = Object.keys(answers)[0];
    if (firstKey && isPlainObject(answers[firstKey])) {
      // formato aninhado { quizRef: { qi: idx } } — usa primeiro quiz disponível
      const ref = quizzes[0].quizRef;
      answersForQuiz = isPlainObject(answers[ref]) ? answers[ref] : answers[firstKey];
    }
  } else {
    answersForQuiz = {};
  }

  const questions = quizzes[0].questions;
  const perQuestion = questions.map((q, qi) => {
    const expected = correctIndexesOf(q);          // array sempre
    const isMultiple = String(q?.type || 'SINGLE').toUpperCase() === 'MULTIPLE' || expected.length > 1;

    // answer pode ser número (SINGLE) ou array de números (MULTIPLE)
    let givenArr = [];
    const raw = answersForQuiz?.[qi];
    if (Array.isArray(raw)) {
      givenArr = raw.map(n => Number(n)).filter(Number.isFinite);
    } else if (Number.isFinite(Number(raw))) {
      givenArr = [Number(raw)];
    }

    // Acerto: conjunto de respostas EXATAMENTE igual ao conjunto esperado.
    const expectedSet = new Set(expected);
    const givenSet = new Set(givenArr);
    const correct = expected.length > 0
      && expectedSet.size === givenSet.size
      && [...expectedSet].every(x => givenSet.has(x));

    return {
      qi,
      expected: isMultiple ? expected : (expected[0] ?? null), // compat: SINGLE devolve número
      given: isMultiple ? givenArr : (givenArr[0] ?? null),
      correct,
    };
  });

  const correctCount = perQuestion.filter((p) => p.correct).length;
  const totalQuestions = perQuestion.length;
  const allCorrect = totalQuestions > 0 && correctCount === totalQuestions;
  const scorePercent = totalQuestions > 0
    ? Math.round((correctCount / totalQuestions) * 100)
    : 0;

  return { totalQuestions, correctCount, allCorrect, scorePercent, perQuestion };
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
  async listTracks({ userId = null } = {}) {
    const tokens = await resolveUserTokens(userId);

    const rows = await db.AcademyTrack.findAll({
      where: {
        [Op.and]: [
          { status: 'PUBLISHED' },
          audiencesWhereLiteral(tokens),
        ],
      },
      attributes: ['slug', 'title', 'description', 'audience', 'audiences', 'updatedAt'],
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

    // S3.3: marca lock state baseado em pré-requisitos
    const allowedSlugs = allowed.map((t) => String(t.slug));
    const lockMap = await prerequisiteService.getLockStateBulk({
      trackSlugs: allowedSlugs,
      userId: userCtx?.userId ? Number(userCtx.userId) : null,
    });

    const results = allowed.map((t) => {
      const slug = String(t.slug);
      const lock = lockMap.get(slug) || { locked: false, blockedBy: [] };
      return {
        ...t.toJSON(),
        progressPercent: progressBySlug.get(slug) ?? 0,
        locked: lock.locked,
        blockedBy: lock.blockedBy,
      };
    });

    return { results };
  },

  async getTrack({ slug, userId = null } = {}) {
    const trackSlug = String(slug || '').trim();
    if (!trackSlug) return null;

    const tokens = await resolveUserTokens(userId);
    const userCtx = await getUserContext(userId);

    const assigns = await db.AcademyTrackAssignment.findAll({
      where: { trackSlug },
      attributes: ['scopeType', 'scopeValue'],
      raw: true,
    });

    if (!isAllowedByAssignmentsRows(assigns, userCtx)) return null;

    const track = await db.AcademyTrack.findOne({
      where: {
        [Op.and]: [
          { slug: trackSlug, status: 'PUBLISHED' },
          audiencesWhereLiteral(tokens),
        ],
      },
      attributes: ['id', 'slug', 'title', 'description', 'audience', 'audiences', 'updatedAt'],
    });
    if (!track) return null;

    // S3.3: bloqueia acesso se pré-requisitos não satisfeitos.
    // Devolve a trilha mas marca locked + blockedBy para o frontend renderizar
    // a tela "complete o curso X primeiro".
    const lockState = await prerequisiteService.getLockState({
      trackSlug,
      userId: userCtx?.userId ? Number(userCtx.userId) : null,
    });

    const itemsRaw = await db.AcademyTrackItem.findAll({
      where: { trackId: track.id },
      attributes: [
        'id',
        'moduleId',
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

    // ⚠️ Defesa em profundidade: items ARTICLE só aparecem se o usuário
    // realmente pode abrir o artigo de destino. Mesmo com a validação no
    // save (assertArticleCoversTrack), bugs/edge cases podem deixar um
    // item órfão — então re-validamos a cada render.
    const articleSlugsToCheck = [];
    for (const it of itemsRaw) {
      if (String(it.type || '').toUpperCase() !== 'ARTICLE') continue;
      const t = String(it.target || '').trim();
      if (!t) continue;
      const slug = t.includes('/') ? t.split('/').filter(Boolean).pop() : t;
      if (slug) articleSlugsToCheck.push(slug);
    }

    let visibleArticleSlugs = new Set();
    if (articleSlugsToCheck.length) {
      const visibleRows = await db.AcademyArticle.findAll({
        where: {
          [Op.and]: [
            { slug: { [Op.in]: articleSlugsToCheck } },
            audiencesWhereLiteral(tokens),
          ],
        },
        attributes: ['slug'],
        raw: true,
      });
      visibleArticleSlugs = new Set(visibleRows.map((r) => r.slug));
    }

    const items = itemsRaw.filter((it) => {
      if (String(it.type || '').toUpperCase() !== 'ARTICLE') return true;
      const t = String(it.target || '').trim();
      if (!t) return true; // sem target — UI já trata
      const slug = t.includes('/') ? t.split('/').filter(Boolean).pop() : t;
      return visibleArticleSlugs.has(slug);
    });

    // S2.1: Carrega módulos da trilha (se houver) para devolver agrupados.
    const modules = await db.AcademyModule.findAll({
      where: { trackId: track.id },
      attributes: ['id', 'orderIndex', 'title', 'description'],
      order: [['orderIndex', 'ASC']],
      raw: true,
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
    // S2.3: para cada item de quiz, queremos a MELHOR tentativa (maior scorePercent)
    // E também a tentativa mais RECENTE (para mostrar perQuestion atual).
    let attemptsByItemId = new Map();
    let attemptCountByItemId = new Map();

    if (userCtx?.userId) {
      const attempts = await db.AcademyUserQuizAttempt.findAll({
        where: { userId: Number(userCtx.userId), trackSlug },
        attributes: ['itemId', 'attemptNumber', 'answers', 'allCorrect', 'scorePercent', 'submittedAt'],
        order: [['attemptNumber', 'ASC']],
        raw: true,
      });

      // Agrupa por itemId
      const byItem = new Map();
      for (const a of attempts) {
        const iid = Number(a.itemId);
        if (!byItem.has(iid)) byItem.set(iid, []);
        byItem.get(iid).push(a);
      }

      for (const [iid, list] of byItem.entries()) {
        const best = list.reduce((acc, x) =>
          (acc == null || Number(x.scorePercent || 0) > Number(acc.scorePercent || 0)) ? x : acc, null);
        const latest = list[list.length - 1];

        attemptsByItemId.set(iid, {
          // Para o renderer: usa a ÚLTIMA tentativa para mostrar as respostas atuais.
          answers: latest.answers,
          allCorrect: !!latest.allCorrect,
          scorePercent: Number(latest.scorePercent || 0),
          submittedAt: latest.submittedAt || null,
          // Estado agregado:
          bestScorePercent: Number(best.scorePercent || 0),
          attemptCount: list.length,
        });
        attemptCountByItemId.set(iid, list.length);
      }
    }

    // S2.2: pré-carrega perguntas do banco para items QUIZ
    const quizItemIds = items
      .filter(i => String(i.type || '').toUpperCase() === 'QUIZ')
      .map(i => Number(i.id));
    const bankQuestionsByItem = new Map();
    if (quizItemIds.length) {
      // Privado (com gabarito) — só para o scoring interno; depois é stripado.
      await Promise.all(quizItemIds.map(async (iid) => {
        try {
          const bq = await questionBankService.loadPrivateForItem(iid);
          if (bq.length) bankQuestionsByItem.set(iid, bq);
        } catch (_) { /* item sem banco — payload inline */ }
      }));
    }

    const outItems = items.map((i) => {
      const id = Number(i.id);
      const attempt = attemptsByItemId.get(id) || null;
      const json = i.toJSON();
      const itemType = String(json.type || '').toUpperCase();

      // S2.2: se o item tem perguntas no banco, monta payload virtual.
      let payloadForScoring = json.payload;
      if (itemType === 'QUIZ' && bankQuestionsByItem.has(id)) {
        const bq = bankQuestionsByItem.get(id);
        payloadForScoring = {
          ...(json.payload || {}),
          quiz: {
            ...(json.payload?.quiz || {}),
            questions: bq.map(q => ({
              text: q.text,
              type: q.type,
              options: q.options,
              correctIndexes: q.correctIndexes,
            })),
          },
        };
      }

      // Para QUIZ com tentativa salva, calcula perQuestion server-side
      // (antes de stripar correctIndex) para que o frontend mostre feedback
      // sem precisar do gabarito.
      // S2.3: também devolve flag `passed` baseado em passingScore do payload.
      let quizAttemptEnriched = attempt;
      if (itemType === 'QUIZ' && attempt && payloadForScoring) {
        const result = scoreQuiz({ payload: payloadForScoring, answers: attempt.answers });
        const passingScore = Math.max(0, Math.min(100, Number(json.payload?.rules?.passingScore ?? 100)));
        quizAttemptEnriched = {
          ...attempt,
          totalQuestions: result.totalQuestions,
          correctCount: result.correctCount,
          // sobrescreve scorePercent calculado pra refletir o estado atual do gabarito
          scorePercent: result.scorePercent,
          passed: result.scorePercent >= passingScore || (attempt.bestScorePercent ?? 0) >= passingScore,
          perQuestion: result.perQuestion, // { qi, expected, given, correct }
        };
      }

      // 🔒 Para QUIZ, payload exposto ao cliente vai com perguntas PÚBLICAS
      // (sem correctIndexes/explanation). Inclui questões do banco mescladas.
      if (itemType === 'QUIZ') {
        let publicPayload = json.payload ? stripQuizAnswerKeys(json.payload) : {};
        if (bankQuestionsByItem.has(id)) {
          const bq = bankQuestionsByItem.get(id);
          publicPayload = {
            ...publicPayload,
            quiz: {
              ...(publicPayload.quiz || {}),
              questions: bq.map(q => ({
                text: q.text,
                type: q.type,
                options: q.options,
                difficulty: q.difficulty,
                tags: q.tags,
              })),
            },
          };
        }
        json.payload = publicPayload;
      }

      // S2.3: metadata pública do quiz (passingScore, maxAttempts, attemptsRemaining)
      let quizMeta = null;
      if (itemType === 'QUIZ') {
        const rules = json.payload?.rules || {};
        const psRaw = Number(rules.passingScore);
        const passingScore = Number.isFinite(psRaw) ? Math.max(0, Math.min(100, psRaw)) : 100;
        const maRaw = Number(rules.maxAttempts);
        const maxAttempts = Number.isFinite(maRaw) && maRaw > 0 ? Math.floor(maRaw) : null;
        const cdRaw = Number(rules.cooldownMinutes);
        const cooldownMinutes = Number.isFinite(cdRaw) && cdRaw > 0 ? Math.floor(cdRaw) : 0;
        const attemptCount = attemptCountByItemId.get(id) || 0;
        quizMeta = {
          passingScore,
          maxAttempts,
          cooldownMinutes,
          attemptCount,
          attemptsRemaining: maxAttempts == null ? null : Math.max(0, maxAttempts - attemptCount),
        };
      }

      return {
        ...json,
        completed: completedIds.has(id),
        quizAttempt: quizAttemptEnriched,
        quizMeta,
      };
    });

    // S2.1: agrupa items por módulo (modules[].items[]) + retorna lista flat
    // como antes (items) para compatibilidade.
    const itemsByModule = new Map();
    const looseItems = [];
    for (const it of outItems) {
      const mid = it.moduleId == null ? null : Number(it.moduleId);
      if (mid == null) {
        looseItems.push(it);
      } else {
        if (!itemsByModule.has(mid)) itemsByModule.set(mid, []);
        itemsByModule.get(mid).push(it);
      }
    }

    const modulesOut = modules.map(m => ({
      ...m,
      items: itemsByModule.get(Number(m.id)) || [],
    }));

    return {
      track: track.toJSON(),
      items: outItems,                  // flat (compat)
      modules: modulesOut,              // agrupado por módulo (S2.1)
      looseItems,                       // items sem módulo (S2.1)
      progressPercent,
      locked: lockState.locked,         // S3.3
      blockedBy: lockState.blockedBy,   // S3.3
    };
  },

  // S3.4: marca apenas a abertura do item (sem completar) — para analytics de drop-off.
  // Chamado quando o aluno abre o modal/visualiza o item pela primeira vez.
  // Idempotente: só insere se NÃO existe registro pra (user, track, item).
  async markOpened({ userId, trackSlug, itemId } = {}) {
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) throw new Error('Usuário não identificado.');
    const slug = String(trackSlug || '').trim();
    if (!slug) throw new Error('Trilha inválida.');
    const id = Number(itemId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('Item inválido.');

    const existing = await db.AcademyUserProgress.findOne({
      where: { userId: uid, trackSlug: slug, itemId: id },
      attributes: ['id', 'openedAt', 'completed'],
    });

    if (existing) {
      // Já existe (talvez completado, talvez só aberto antes). Só preenche openedAt se vazio.
      if (!existing.openedAt) {
        existing.openedAt = new Date();
        await existing.save();
      }
      return { ok: true };
    }

    // Cria registro com completed=false e openedAt=now.
    await db.AcademyUserProgress.create({
      userId: uid,
      trackSlug: slug,
      itemId: id,
      completed: false,
      openedAt: new Date(),
    });
    return { ok: true };
  },

  async markProgress({ userId, trackSlug, itemId, completed = true, ip = null, userAgent = null } = {}) {
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) throw new Error('Usuário não identificado.');

    const slug = String(trackSlug || '').trim();
    if (!slug || slug === 'undefined') throw new Error('Trilha inválida.');

    const id = Number(itemId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('Item inválido.');

    // S3.3: bloqueia marcação de progresso em trilha LOCKED.
    const lockState = await prerequisiteService.getLockState({ trackSlug: slug, userId: uid });
    if (lockState.locked) {
      const blockedTitles = lockState.blockedBy.map(b => b.title || b.slug).join(', ');
      const err = new Error(`Trilha bloqueada. Conclua primeiro: ${blockedTitles}.`);
      err.statusCode = 403;
      err.blockedBy = lockState.blockedBy;
      throw err;
    }

    if (completed) {
      await db.AcademyUserProgress.upsert({
        userId: uid,
        trackSlug: slug,
        itemId: id,
        completed: true,
        completedAt: new Date(),
        ip,
        userAgent,
      });

      // S5.1: XP por item concluído (idempotente por refKind+refId)
      gamificationService.awardXp({
        userId: uid,
        reason: 'ITEM_COMPLETED',
        refKind: 'item',
        refId: String(id),
      }).catch(err => console.warn('[gamification.itemCompleted]', err?.message));
    } else {
      await db.AcademyUserProgress.destroy({ where: { userId: uid, trackSlug: slug, itemId: id } });
    }

    // Lê estado anterior do trackProgress ANTES do upsert (para detectar transição).
    const priorRow = await db.AcademyUserTrackProgress.findOne({
      where: { userId: uid, trackSlug: slug },
      attributes: ['progressPercent'],
      raw: true,
    });
    const priorPercent = Number(priorRow?.progressPercent ?? 0);

    const detail = await this.getTrack({ slug, userId: uid });
    const percent = Number(detail?.progressPercent ?? 0);
    const status = normalizeTrackStatus(percent);

    await db.AcademyUserTrackProgress.upsert({
      userId: uid,
      trackSlug: slug,
      status,
      progressPercent: percent,
    });

    // Conclusão (< 100 → 100): emite certificado (que internamente notifica o user).
    let certificate = null;
    if (percent >= 100 && priorPercent < 100) {
      try {
        const result = await certificateService.issue({
          userId: uid,
          trackSlug: slug,
          ip,
          userAgent,
        });
        certificate = result?.certificate || null;
      } catch (certErr) {
        console.warn('[academy.tracks.markProgress] certificate issue failed', certErr?.message);
      }

      // S3.3: notifica trilhas que dependiam desta como pré-requisito.
      prerequisiteService.notifyUnlocks({ userId: uid, completedTrackSlug: slug })
        .catch(err => console.warn('[academy.tracks.markProgress] notifyUnlocks failed', err?.message));

      // S5.1: XP por trilha concluída
      gamificationService.awardXp({
        userId: uid,
        reason: 'TRACK_COMPLETED',
        refKind: 'track',
        refId: slug,
      }).catch(err => console.warn('[gamification.trackCompleted]', err?.message));
    }

    return { ok: true, ...detail, certificate };
  },

  async submitQuizAttempt({ userId, trackSlug, itemId, answers = {} } = {}) {
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) throw new Error('Usuário não identificado.');

    const slug = String(trackSlug || '').trim();
    if (!slug || slug === 'undefined') throw new Error('Trilha inválida.');

    const id = Number(itemId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('Item inválido.');

    if (answers == null || typeof answers !== 'object') {
      dwarn('submitQuizAttempt(): unexpected answers type', { slug, id, answersType: typeof answers });
      throw new Error('Respostas inválidas.');
    }

    // 🔒 Lê o item REAL do banco e calcula scorePercent server-side.
    const track = await db.AcademyTrack.findOne({
      where: { slug, status: 'PUBLISHED' },
      attributes: ['id'],
    });
    if (!track) throw new Error('Trilha não encontrada.');

    const item = await db.AcademyTrackItem.findOne({
      where: { id, trackId: track.id },
      attributes: ['id', 'type', 'payload'],
    });
    if (!item) throw new Error('Item não encontrado nesta trilha.');

    if (String(item.type || '').toUpperCase() !== 'QUIZ') {
      throw new Error('Item não é um quiz.');
    }

    // S2.3: lê regras do payload do item.
    //   passingScore: % mínima para "passou" (default 100 = mesma semântica antiga de allCorrect)
    //   maxAttempts: null = ilimitado; nº = trava em N tentativas
    //   cooldownMinutes: tempo mínimo entre tentativas (0 = sem cooldown)
    // Proteção contra valores não-numéricos no payload: Number() retorna NaN
    // que se propaga em Math.min/Math.max — então valida explicitamente.
    const rules = item.payload?.rules || {};
    const psRaw = Number(rules.passingScore);
    const passingScore = Number.isFinite(psRaw) ? Math.max(0, Math.min(100, psRaw)) : 100;

    const maRaw = Number(rules.maxAttempts);
    const maxAttempts = Number.isFinite(maRaw) && maRaw > 0 ? Math.floor(maRaw) : null;

    const cdRaw = Number(rules.cooldownMinutes);
    const cooldownMinutes = Number.isFinite(cdRaw) && cdRaw > 0 ? Math.floor(cdRaw) : 0;

    // S2.3: conta tentativas anteriores E valida políticas.
    const previousAttempts = await db.AcademyUserQuizAttempt.findAll({
      where: { userId: uid, trackSlug: slug, itemId: id },
      attributes: ['attemptNumber', 'allCorrect', 'scorePercent', 'submittedAt'],
      order: [['attemptNumber', 'DESC']],
      raw: true,
    });

    const lastAttempt = previousAttempts[0] || null;
    const attemptCount = previousAttempts.length;

    // Se já passou em alguma tentativa anterior, bloqueia novo submit
    // (evita "regredir" o status — se quiser melhorar nota, faça via UI separada de re-take).
    const alreadyPassed = previousAttempts.some(a => Number(a.scorePercent || 0) >= passingScore);
    if (alreadyPassed) {
      const err = new Error('Você já foi aprovado neste quiz.');
      err.statusCode = 409;
      throw err;
    }

    if (maxAttempts != null && attemptCount >= maxAttempts) {
      const err = new Error(`Limite de ${maxAttempts} tentativa(s) atingido.`);
      err.statusCode = 429;
      throw err;
    }

    if (cooldownMinutes > 0 && lastAttempt?.submittedAt) {
      const elapsedMs = Date.now() - new Date(lastAttempt.submittedAt).getTime();
      const cooldownMs = cooldownMinutes * 60 * 1000;
      if (elapsedMs < cooldownMs) {
        const remainingMin = Math.ceil((cooldownMs - elapsedMs) / 60000);
        const err = new Error(`Aguarde ${remainingMin} min antes de tentar novamente.`);
        err.statusCode = 429;
        err.cooldownRemainingMin = remainingMin;
        throw err;
      }
    }

    // S2.2: mescla banco de questões se houver.
    const bankQuestions = await questionBankService.loadPrivateForItem(item.id).catch(() => []);
    let payloadForScoring = item.payload;
    if (bankQuestions.length > 0) {
      payloadForScoring = {
        ...(item.payload || {}),
        quiz: {
          ...(item.payload?.quiz || {}),
          questions: bankQuestions.map(q => ({
            text: q.text,
            type: q.type,
            options: q.options,
            correctIndexes: q.correctIndexes,
          })),
        },
      };
    }

    const result = scoreQuiz({ payload: payloadForScoring, answers });

    if (result.totalQuestions === 0) {
      throw new Error('Quiz sem perguntas configuradas.');
    }

    const passed = result.scorePercent >= passingScore;
    const nextAttemptNumber = attemptCount + 1;

    // S5.1: XP por quiz passado (1ª vez apenas — idempotente por refId=item)
    if (passed) {
      gamificationService.awardXp({
        userId: uid,
        reason: 'QUIZ_PASSED',
        refKind: 'quiz',
        refId: String(id),
      }).catch(err => console.warn('[gamification.quizPassed]', err?.message));
    }

    await db.AcademyUserQuizAttempt.create({
      userId: uid,
      trackSlug: slug,
      itemId: id,
      attemptNumber: nextAttemptNumber,
      answers,
      allCorrect: result.allCorrect,
      scorePercent: result.scorePercent,
      submittedAt: new Date(),
    });

    const detail = await this.getTrack({ slug, userId: uid });

    return {
      ok: true,
      ...detail,
      quizResult: {
        totalQuestions: result.totalQuestions,
        correctCount: result.correctCount,
        allCorrect: result.allCorrect,
        scorePercent: result.scorePercent,
        passed,
        passingScore,
        attemptNumber: nextAttemptNumber,
        attemptsRemaining: maxAttempts == null ? null : Math.max(0, maxAttempts - nextAttemptNumber),
        perQuestion: result.perQuestion,
      },
    };
  },
};

export default trackService;

// services/academy/questionBankService.js
//
// CRUD do banco de questões reutilizável + ligação de perguntas a um quiz item.
// Compatibilidade total com payload inline existente: quiz pode usar
//   payload.questions (inline, formato antigo)
//   OU payload.questionRefs: [questionId] (novo, do banco)
//   OU AcademyQuizQuestion (relação many-to-many limpa via tabela).
//
// scoreQuiz consolida tudo: prioridade AcademyQuizQuestion > payload.questionRefs > payload.questions.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

function normStr(v) { return String(v ?? '').trim(); }

function normalizeType(v) {
    const t = String(v || 'SINGLE').toUpperCase();
    return ['SINGLE', 'MULTIPLE'].includes(t) ? t : 'SINGLE';
}

function normalizeDifficulty(v) {
    const d = String(v || 'MEDIUM').toUpperCase();
    return ['EASY', 'MEDIUM', 'HARD'].includes(d) ? d : 'MEDIUM';
}

function normalizeOptions(opts) {
    if (!Array.isArray(opts)) throw new Error('options deve ser array de strings.');
    const out = opts.map(o => String(o ?? '').trim()).filter(Boolean);
    if (out.length < 2) throw new Error('Pelo menos 2 opções são necessárias.');
    return out;
}

function normalizeCorrectIndexes(arr, optionsLen, type) {
    if (!Array.isArray(arr)) throw new Error('correctIndexes deve ser array de inteiros.');
    const out = arr
        .map(n => Number(n))
        .filter(n => Number.isInteger(n) && n >= 0 && n < optionsLen);
    if (!out.length) throw new Error('Pelo menos um correctIndex válido é necessário.');
    if (type === 'SINGLE' && out.length !== 1) {
        throw new Error('Quiz SINGLE deve ter exatamente 1 correctIndex.');
    }
    if (type === 'MULTIPLE' && out.length < 2) {
        throw new Error('Quiz MULTIPLE deve ter pelo menos 2 correctIndexes.');
    }
    // dedup + sort
    return [...new Set(out)].sort((a, b) => a - b);
}

function normalizeTags(v) {
    if (!Array.isArray(v)) return [];
    return v.map(t => String(t ?? '').trim()).filter(Boolean);
}

// Strip correctIndexes/explanation antes de devolver ao aluno (gabarito privado).
function publicQuestion(q) {
    return {
        id: q.id,
        text: q.text,
        type: q.type,
        options: q.options,
        difficulty: q.difficulty,
        tags: q.tags,
    };
}

const questionBankService = {
    // Listagem admin
    async list({ q, tags, difficulty, status, page = 1, pageSize = 20 } = {}) {
        const where = {};
        if (status) where.status = String(status).toUpperCase();
        else where.status = 'ACTIVE';
        if (difficulty) where.difficulty = normalizeDifficulty(difficulty);
        if (q && String(q).trim()) {
            where.text = { [Op.iLike]: `%${String(q).trim()}%` };
        }
        if (tags && Array.isArray(tags) && tags.length) {
            // Postgres JSONB contains-any (qualquer tag bate)
            where[Op.and] = tags.map(t => ({
                tags: { [Op.contains]: [String(t).trim()] },
            }));
        }

        const safePage = Math.max(1, Number(page) || 1);
        const safePageSize = Math.min(200, Math.max(1, Number(pageSize) || 20));
        const offset = (safePage - 1) * safePageSize;

        const { rows, count } = await db.AcademyQuestion.findAndCountAll({
            where,
            attributes: ['id', 'text', 'type', 'options', 'difficulty', 'tags', 'status', 'createdAt', 'updatedAt'],
            order: [['updatedAt', 'DESC']],
            limit: safePageSize,
            offset,
        });

        return { page: safePage, pageSize: safePageSize, total: count, results: rows };
    },

    async getById({ id, includeAnswerKey = false }) {
        const row = await db.AcademyQuestion.findByPk(Number(id));
        if (!row) throw new Error('Pergunta não encontrada.');
        const json = row.toJSON();
        if (!includeAnswerKey) {
            // mesmo no admin, só inclui correctIndexes quando explicitamente pedido
            delete json.correctIndexes;
            delete json.explanation;
        }
        return { question: json };
    },

    async create({ userId, payload }) {
        const text = normStr(payload?.text);
        if (!text) throw new Error('Texto é obrigatório.');

        const type = normalizeType(payload?.type);
        const options = normalizeOptions(payload?.options);
        const correctIndexes = normalizeCorrectIndexes(payload?.correctIndexes, options.length, type);
        const explanation = payload?.explanation ? normStr(payload.explanation) : null;
        const tags = normalizeTags(payload?.tags);
        const difficulty = normalizeDifficulty(payload?.difficulty);

        const created = await db.AcademyQuestion.create({
            text,
            type,
            options,
            correctIndexes,
            explanation,
            tags,
            difficulty,
            createdByUserId: userId || null,
            updatedByUserId: userId || null,
            status: 'ACTIVE',
        });

        return { question: created.toJSON() };
    },

    async update({ id, userId, payload }) {
        const q = await db.AcademyQuestion.findByPk(Number(id));
        if (!q) throw new Error('Pergunta não encontrada.');

        if (payload?.text !== undefined) {
            const t = normStr(payload.text);
            if (!t) throw new Error('Texto é obrigatório.');
            q.text = t;
        }
        if (payload?.type !== undefined) q.type = normalizeType(payload.type);

        // Se options OU correctIndexes mudaram, re-valida em conjunto.
        if (payload?.options !== undefined || payload?.correctIndexes !== undefined) {
            const opts = payload?.options !== undefined
                ? normalizeOptions(payload.options)
                : q.options;
            const corrs = payload?.correctIndexes !== undefined
                ? normalizeCorrectIndexes(payload.correctIndexes, opts.length, q.type)
                : normalizeCorrectIndexes(q.correctIndexes, opts.length, q.type);
            q.options = opts;
            q.correctIndexes = corrs;
        }

        if (payload?.explanation !== undefined) {
            q.explanation = payload.explanation ? normStr(payload.explanation) : null;
        }
        if (payload?.tags !== undefined) q.tags = normalizeTags(payload.tags);
        if (payload?.difficulty !== undefined) q.difficulty = normalizeDifficulty(payload.difficulty);
        if (payload?.status !== undefined) {
            const s = String(payload.status).toUpperCase();
            q.status = ['ACTIVE', 'ARCHIVED'].includes(s) ? s : q.status;
        }

        q.updatedByUserId = userId || q.updatedByUserId || null;
        await q.save();
        return { question: q.toJSON() };
    },

    async archive({ id }) {
        const q = await db.AcademyQuestion.findByPk(Number(id));
        if (!q) throw new Error('Pergunta não encontrada.');
        q.status = 'ARCHIVED';
        await q.save();
        return { ok: true };
    },

    // ──── Quiz item ↔ banco de questões (S2.2) ─────────────────────────────

    // Liga uma pergunta do banco a um quiz item.
    async attachToItem({ itemId, questionId, orderIndex = null, points = 1 }) {
        const item = await db.AcademyTrackItem.findByPk(Number(itemId));
        if (!item) throw new Error('Item não encontrado.');
        if (String(item.type).toUpperCase() !== 'QUIZ') {
            throw new Error('Item não é do tipo QUIZ.');
        }
        const q = await db.AcademyQuestion.findByPk(Number(questionId));
        if (!q) throw new Error('Pergunta não encontrada.');
        if (q.status !== 'ACTIVE') throw new Error('Pergunta arquivada.');

        let oi = orderIndex;
        if (oi == null) {
            const max = await db.AcademyQuizQuestion.max('orderIndex', { where: { itemId: item.id } });
            oi = (Number(max) || 0) + 1;
        }

        try {
            const link = await db.AcademyQuizQuestion.create({
                itemId: item.id,
                questionId: q.id,
                orderIndex: oi,
                points: Math.max(1, Number(points) || 1),
            });
            return { link: link.toJSON() };
        } catch (err) {
            if (err?.name === 'SequelizeUniqueConstraintError') {
                throw new Error('Esta pergunta já está vinculada a este item.');
            }
            throw err;
        }
    },

    async detachFromItem({ itemId, questionId }) {
        await db.AcademyQuizQuestion.destroy({
            where: { itemId: Number(itemId), questionId: Number(questionId) },
        });
        return { ok: true };
    },

    // Lista perguntas vinculadas a um quiz item (com gabarito apenas se admin).
    async listByItem({ itemId, includeAnswerKey = false }) {
        const links = await db.AcademyQuizQuestion.findAll({
            where: { itemId: Number(itemId) },
            order: [['orderIndex', 'ASC']],
            include: [{
                model: db.AcademyQuestion,
                as: 'question',
                attributes: ['id', 'text', 'type', 'options', 'correctIndexes', 'explanation', 'difficulty', 'tags'],
            }],
        });

        return {
            results: links.map(l => {
                const q = l.question?.toJSON?.() || {};
                if (!includeAnswerKey) {
                    delete q.correctIndexes;
                    delete q.explanation;
                }
                return {
                    questionId: l.questionId,
                    orderIndex: l.orderIndex,
                    points: l.points,
                    ...q,
                };
            }),
        };
    },

    // Helper público (sem gabarito) — chamado pelo trackService.getTrack para
    // incluir perguntas no payload do item de QUIZ.
    async loadPublicForItem(itemId) {
        const data = await this.listByItem({ itemId, includeAnswerKey: false });
        return data.results.map(publicQuestion);
    },

    // Helper privado (com gabarito) — chamado pelo scoreQuiz no submit.
    async loadPrivateForItem(itemId) {
        const data = await this.listByItem({ itemId, includeAnswerKey: true });
        return data.results; // contém correctIndexes
    },
};

export default questionBankService;

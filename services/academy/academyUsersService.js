import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

function normalizeAudience(a) {
    return ['BOTH', 'GESTOR_ONLY', 'ADM_ONLY'].includes(a) ? a : 'BOTH';
}

function audienceWhere(a) {
    if (a === 'BOTH') return { audience: { [Op.in]: ['BOTH', 'GESTOR_ONLY', 'ADM_ONLY'] } };
    return { audience: { [Op.in]: ['BOTH', a] } };
}

function safePage(n) {
    const v = Number(n);
    return Number.isFinite(v) && v > 0 ? v : 1;
}

function safePageSize(n) {
    const v = Number(n);
    return Math.min(100, Math.max(1, Number.isFinite(v) ? v : 20));
}

function computeScore({ published = 0, answersPosted = 0, topicsCreated = 0, completed = 0 }) {
    return published * 20 + answersPosted * 3 + topicsCreated * 10 + completed * 25;
}

const academyUsersService = {
    // reusa o seu meService mas sem depender do request
    async getUserSummary({ userId, audience }) {
        const finalAudience = normalizeAudience(audience);

        const user = await db.User.findByPk(userId, {
            attributes: ['id', 'username', 'email', 'position', 'city', 'createdAt'],
        });

        if (!user) throw new Error('Usuário não encontrado.');

        const [kbDrafts, kbPublished] = await Promise.all([
            db.AcademyArticle.count({ where: { createdByUserId: userId, status: 'DRAFT' } }),
            db.AcademyArticle.count({ where: { createdByUserId: userId, status: 'PUBLISHED' } }),
        ]);

        const [topicsCreated, answersPosted] = await Promise.all([
            db.AcademyTopic.count({ where: { createdByUserId: userId, ...audienceWhere(finalAudience) } }),
            db.AcademyPost.count({ where: { createdByUserId: userId, type: 'ANSWER' } }),
        ]);

        const trackRows = await db.AcademyUserTrackProgress.findAll({
            where: { userId },
            attributes: ['trackSlug', 'status', 'progressPercent', 'updatedAt'],
            order: [['updatedAt', 'DESC']],
            raw: true,
        });

        const completed = trackRows.filter(r => r.status === 'COMPLETED').length;
        const inProgress = trackRows.filter(r => r.status === 'IN_PROGRESS').length;

        // opcional: trackTitle aqui também (se você quiser no público)
        const slugs = [...new Set(trackRows.map(r => r.trackSlug).filter(Boolean))];
        const trackDefs = slugs.length
            ? await db.AcademyTrack.findAll({
                where: { slug: { [Op.in]: slugs }, status: 'PUBLISHED', ...audienceWhere(finalAudience) },
                attributes: ['slug', 'title'],
                raw: true,
            })
            : [];
        const titleBySlug = Object.fromEntries(trackDefs.map(t => [t.slug, t.title]));

        const list = trackRows.map(r => ({
            trackSlug: r.trackSlug,
            trackTitle: titleBySlug[r.trackSlug] || r.trackSlug,
            status: r.status,
            progressPercent: r.progressPercent,
            updatedAt: r.updatedAt,
        }));

        const score = computeScore({
            published: kbPublished,
            answersPosted,
            topicsCreated,
            completed,
        });

        return {
            audience: finalAudience,
            user: user.toJSON(),
            kb: { drafts: kbDrafts, published: kbPublished, total: kbDrafts + kbPublished },
            community: { topicsCreated, answersPosted },
            tracks: { completed, inProgress, list },
            score,
        };
    },

    async rank({ q, page, pageSize, audience }) {
        const finalAudience = normalizeAudience(audience);

        const p = safePage(page);
        const ps = safePageSize(pageSize);
        const offset = (p - 1) * ps;

        // 1) filtra usuários (busca por username)
        const userWhere = {};
        if (q && String(q).trim()) {
            userWhere.username = { [Op.iLike]: `%${String(q).trim()}%` };
        }

        const { rows: users, count: total } = await db.User.findAndCountAll({
            where: userWhere,
            attributes: ['id', 'username', 'email', 'position', 'city', 'createdAt'],
            order: [['username', 'ASC']],
            limit: ps,
            offset,
            raw: true,
        });

        const userIds = users.map(u => u.id);

        if (!userIds.length) {
            return { page: p, pageSize: ps, total, results: [] };
        }

        // 2) agregações por usuário (em paralelo)
        const [kbPublishedRows, kbDraftRows, topicRows, answerRows, trackCompletedRows, trackInProgressRows] =
            await Promise.all([
                db.AcademyArticle.findAll({
                    where: { createdByUserId: { [Op.in]: userIds }, status: 'PUBLISHED' },
                    attributes: ['createdByUserId', [db.Sequelize.fn('COUNT', db.Sequelize.col('id')), 'count']],
                    group: ['created_by_user_id'],
                    raw: true,
                }),
                db.AcademyArticle.findAll({
                    where: { createdByUserId: { [Op.in]: userIds }, status: 'DRAFT' },
                    attributes: ['createdByUserId', [db.Sequelize.fn('COUNT', db.Sequelize.col('id')), 'count']],
                    group: ['created_by_user_id'],
                    raw: true,
                }),
                db.AcademyTopic.findAll({
                    where: { createdByUserId: { [Op.in]: userIds }, ...audienceWhere(finalAudience) },
                    attributes: ['createdByUserId', [db.Sequelize.fn('COUNT', db.Sequelize.col('id')), 'count']],
                    group: ['created_by_user_id'],
                    raw: true,
                }),
                db.AcademyPost.findAll({
                    where: { createdByUserId: { [Op.in]: userIds }, type: 'ANSWER' },
                    attributes: ['createdByUserId', [db.Sequelize.fn('COUNT', db.Sequelize.col('id')), 'count']],
                    group: ['created_by_user_id'],
                    raw: true,
                }),
                db.AcademyUserTrackProgress.findAll({
                    where: { userId: { [Op.in]: userIds }, status: 'COMPLETED' },
                    attributes: ['userId', [db.Sequelize.fn('COUNT', db.Sequelize.col('id')), 'count']],
                    group: ['user_id'],
                    raw: true,
                }),
                db.AcademyUserTrackProgress.findAll({
                    where: { userId: { [Op.in]: userIds }, status: 'IN_PROGRESS' },
                    attributes: ['userId', [db.Sequelize.fn('COUNT', db.Sequelize.col('id')), 'count']],
                    group: ['user_id'],
                    raw: true,
                }),
            ]);

        const byUser = (rows, key) =>
            Object.fromEntries(rows.map(r => [Number(r[key]), Number(r.count || 0)]));

        const kbPublishedBy = byUser(kbPublishedRows, 'createdByUserId');
        const kbDraftBy = byUser(kbDraftRows, 'createdByUserId');
        const topicsBy = byUser(topicRows, 'createdByUserId');
        const answersBy = byUser(answerRows, 'createdByUserId');
        const completedBy = byUser(trackCompletedRows, 'userId');
        const inProgressBy = byUser(trackInProgressRows, 'userId');

        // 3) monta resultados + score
        const results = users.map(u => {
            const published = kbPublishedBy[u.id] || 0;
            const drafts = kbDraftBy[u.id] || 0;
            const topicsCreated = topicsBy[u.id] || 0;
            const answersPosted = answersBy[u.id] || 0;
            const completed = completedBy[u.id] || 0;
            const inProgress = inProgressBy[u.id] || 0;

            const score = computeScore({ published, answersPosted, topicsCreated, completed });

            return {
                user: u,
                kb: { drafts, published, total: drafts + published },
                community: { topicsCreated, answersPosted },
                tracks: { completed, inProgress },
                score,
                updatedAt: new Date().toISOString(), // opcional
            };
        });

        // 4) ordena por score desc (e username como tie-breaker)
        results.sort((a, b) => (b.score - a.score) || String(a.user.username).localeCompare(String(b.user.username)));

        return { page: p, pageSize: ps, total, results };
    },
};

export default academyUsersService;

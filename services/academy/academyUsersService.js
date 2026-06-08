import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { resolveUserTokens, audiencesWhereLiteral } from './audience.js';

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
    // O perfil público de um user: estatísticas filtradas pelos tokens
    // do VIEWER (não do alvo). Isso evita vazar contagens de tópicos restritos.
    async getUserSummary({ userId, viewerUserId = null }) {
        const tokens = await resolveUserTokens(viewerUserId);
        const audWhere = audiencesWhereLiteral(tokens);

        const user = await db.User.findByPk(userId, {
            attributes: ['id', 'username', 'email', 'position', 'city', 'createdAt'],
        });

        if (!user) throw new Error('Usuário não encontrado.');

        const [kbDrafts, kbPublished] = await Promise.all([
            db.AcademyArticle.count({ where: { createdByUserId: userId, status: 'DRAFT' } }),
            db.AcademyArticle.count({ where: { createdByUserId: userId, status: 'PUBLISHED' } }),
        ]);

        const [topicsCreated, answersPosted] = await Promise.all([
            db.AcademyTopic.count({
                where: { [Op.and]: [{ createdByUserId: userId }, audWhere] },
            }),
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
                where: {
                    [Op.and]: [
                        { slug: { [Op.in]: slugs }, status: 'PUBLISHED' },
                        audWhere,
                    ],
                },
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
            tokens,
            user: user.toJSON(),
            kb: { drafts: kbDrafts, published: kbPublished, total: kbDrafts + kbPublished },
            community: { topicsCreated, answersPosted },
            tracks: { completed, inProgress, list },
            score,
        };
    },

    async rank({ q, page, pageSize, viewerUserId = null, scopeType = null, scopeValue = null } = {}) {
        const tokens = await resolveUserTokens(viewerUserId);
        const audWhere = audiencesWhereLiteral(tokens);

        const p = safePage(page);
        const ps = safePageSize(pageSize);

        // 1) Busca usuários ativos. Suporta scope filter (S5.4):
        //    - DEPARTMENT → users cuja position pertence a esse department
        //    - POSITION   → users com essa position (filtrado por Position.code → name)
        //    - CITY       → users dessa cidade
        //    - ROLE       → users com esse role
        //    Sem scope → ranking global.
        const userWhere = { status: true };
        if (q && String(q).trim()) {
            userWhere.username = { [Op.iLike]: `%${String(q).trim()}%` };
        }

        if (scopeType && scopeValue != null) {
            const st = String(scopeType).toUpperCase().trim();
            const sv = String(scopeValue).trim();

            if (st === 'ROLE') {
                userWhere.role = sv;
            } else if (st === 'POSITION') {
                const pos = await db.Position.findOne({
                    where: { code: sv },
                    attributes: ['name'],
                    raw: true,
                });
                if (!pos?.name) return { page: p, pageSize: ps, total: 0, results: [], scope: { type: st, value: sv } };
                userWhere.position = pos.name;
            } else if (st === 'DEPARTMENT') {
                const positions = await db.Position.findAll({
                    where: { department_id: Number(sv) },
                    attributes: ['name'],
                    raw: true,
                });
                const names = positions.map(p2 => p2.name).filter(Boolean);
                if (!names.length) return { page: p, pageSize: ps, total: 0, results: [], scope: { type: st, value: sv } };
                userWhere.position = { [Op.in]: names };
            } else if (st === 'CITY') {
                const city = await db.UserCity.findByPk(Number(sv), { attributes: ['name'], raw: true });
                if (!city?.name) return { page: p, pageSize: ps, total: 0, results: [], scope: { type: st, value: sv } };
                userWhere.city = city.name;
            }
        }

        const users = await db.User.findAll({
            where: userWhere,
            attributes: ['id', 'username', 'email', 'position', 'city', 'createdAt'],
            raw: true,
        });

        const total = users.length;
        const userIds = users.map(u => u.id);

        if (!userIds.length) {
            return { page: p, pageSize: ps, total: 0, results: [] };
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
                    where: {
                        [Op.and]: [
                            { createdByUserId: { [Op.in]: userIds } },
                            audWhere,
                        ],
                    },
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

        // 3) monta resultados + score para TODOS os usuários
        const allResults = users.map(u => {
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
            };
        });

        // 4) ordena por score GLOBAL desc (username como tie-breaker), depois pagina
        allResults.sort((a, b) =>
            (b.score - a.score) || String(a.user.username).localeCompare(String(b.user.username))
        );

        const offset = (p - 1) * ps;
        const results = allResults
            .slice(offset, offset + ps)
            .map((r, idx) => ({ ...r, rank: offset + idx + 1 }));

        return { page: p, pageSize: ps, total, results };
    },
};

export default academyUsersService;

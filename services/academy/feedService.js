// services/academy/feedService.js
//
// Feed personalizado /me/feed — agrega eventos relevantes para um user.
//
// Tipos de evento:
//   - NEW_ARTICLE          → artigo publicado em categoria seguida ou audience do user
//   - TOPIC_REPLY          → resposta nova em tópico seguido
//   - NEW_TOPIC            → tópico novo em categoria seguida (KB ou Community)
//   - TRACK_PUBLISHED      → trilha nova atribuída ao user
//   - USER_ACTIVITY        → user seguido publicou artigo / criou tópico
//   - PREREQUISITE_UNLOCK  → user concluiu pré-req — destaca trilha desbloqueada
//
// Ordenação: createdAt DESC. Limitamos cada fonte a ~20 eventos recentes
// (últimos 30 dias) e juntamos em ordem cronológica.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import followService from './followService.js';
import { resolveUserTokens, audiencesWhereLiteral } from './audience.js';

const HORIZON_DAYS = 30;
const PER_SOURCE_LIMIT = 20;

function horizonDate() {
    return new Date(Date.now() - HORIZON_DAYS * 24 * 60 * 60 * 1000);
}

const feedService = {
    /**
     * Constrói feed para um user. Retorna lista ordenada por timestamp DESC.
     *
     * @param {number} userId
     * @param {object} opts
     * @param {number} opts.page
     * @param {number} opts.pageSize
     * @returns {Promise<{page, pageSize, total, results}>}
     */
    async buildFeed({ userId, page = 1, pageSize = 20 } = {}) {
        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0) {
            return { page: 1, pageSize, total: 0, results: [] };
        }

        const since = horizonDate();
        const tokens = await resolveUserTokens(uid);
        const audWhere = audiencesWhereLiteral(tokens);

        // 1) follows do user
        const follows = await db.AcademyFollow.findAll({
            where: { followerId: uid },
            attributes: ['targetType', 'targetRef'],
            raw: true,
        });
        const followedUsers = follows.filter(f => f.targetType === 'USER').map(f => Number(f.targetRef));
        const followedTracks = follows.filter(f => f.targetType === 'TRACK').map(f => f.targetRef);
        const followedTopics = follows.filter(f => f.targetType === 'TOPIC').map(f => Number(f.targetRef));
        const followedCategories = follows.filter(f => f.targetType === 'CATEGORY').map(f => f.targetRef);

        const events = [];

        // ─── 2) Artigos novos (publicados em categorias seguidas OU recentes na audience do user)
        const articleAndConds = [
            { status: 'PUBLISHED', updatedAt: { [Op.gte]: since } },
            audWhere,
        ];
        // Se user segue categorias, prioriza-as. Se não, mostra recentes (geral).
        if (followedCategories.length) {
            articleAndConds.push({ categorySlug: { [Op.in]: followedCategories } });
        }
        const newArticles = await db.AcademyArticle.findAll({
            where: { [Op.and]: articleAndConds },
            attributes: ['id', 'title', 'slug', 'categorySlug', 'createdByUserId', 'updatedAt', 'createdAt'],
            order: [['updatedAt', 'DESC']],
            limit: PER_SOURCE_LIMIT,
            raw: true,
        });
        for (const a of newArticles) {
            events.push({
                type: 'NEW_ARTICLE',
                timestamp: a.updatedAt,
                title: a.title,
                snippet: '',
                link: `/academy/kb/${encodeURIComponent(a.categorySlug)}/${encodeURIComponent(a.slug)}`,
                ref: { kind: 'article', id: a.id, slug: a.slug, categorySlug: a.categorySlug },
                authorId: a.createdByUserId,
                reason: followedCategories.includes(a.categorySlug) ? 'category-follow' : 'audience',
            });
        }

        // ─── 3) Tópicos seguidos com posts novos
        if (followedTopics.length) {
            const newPosts = await db.AcademyPost.findAll({
                where: {
                    topicId: { [Op.in]: followedTopics },
                    createdAt: { [Op.gte]: since },
                },
                attributes: ['id', 'topicId', 'body', 'createdByUserId', 'createdAt'],
                order: [['createdAt', 'DESC']],
                limit: PER_SOURCE_LIMIT,
                raw: true,
            });
            const topicIds = [...new Set(newPosts.map(p => Number(p.topicId)))];
            const topics = topicIds.length
                ? await db.AcademyTopic.findAll({
                    where: { [Op.and]: [{ id: { [Op.in]: topicIds } }, audWhere] },
                    attributes: ['id', 'title'],
                    raw: true,
                })
                : [];
            const titleById = Object.fromEntries(topics.map(t => [t.id, t.title]));

            for (const p of newPosts) {
                const title = titleById[p.topicId];
                if (!title) continue; // tópico fora da audience do user
                const snippet = String(p.body || '').slice(0, 140);
                events.push({
                    type: 'TOPIC_REPLY',
                    timestamp: p.createdAt,
                    title: `Resposta em "${title}"`,
                    snippet,
                    link: `/academy/community/topic/${p.topicId}`,
                    ref: { kind: 'post', id: p.id, topicId: p.topicId },
                    authorId: p.createdByUserId,
                    reason: 'topic-follow',
                });
            }
        }

        // ─── 4) Novas trilhas atribuídas ao user (publicadas recentemente)
        // Cobre TODOS os scopes (USER, ROLE, POSITION, DEPARTMENT, CITY) via
        // userContext — não só USER. Usuário com role=admin não recebe múltiplas
        // notificações redundantes porque o feed deduplica por link no final.
        const userCtxForFeed = await db.User.findByPk(uid, {
            attributes: ['id', 'role', 'position', 'city'],
            raw: true,
        });

        const assignmentOrConds = [{ scopeType: 'USER', scopeValue: String(uid) }];
        if (userCtxForFeed?.role) {
            assignmentOrConds.push({ scopeType: 'ROLE', scopeValue: String(userCtxForFeed.role) });
        }
        if (userCtxForFeed?.position) {
            const pos = await db.Position.findOne({
                where: { active: true, name: { [Op.iLike]: userCtxForFeed.position } },
                attributes: ['code', 'department_id'],
                raw: true,
            });
            if (pos?.code) {
                assignmentOrConds.push({ scopeType: 'POSITION', scopeValue: String(pos.code) });
            }
            if (pos?.department_id) {
                assignmentOrConds.push({ scopeType: 'DEPARTMENT', scopeValue: String(pos.department_id) });
            }
        }
        if (userCtxForFeed?.city) {
            const city = await db.UserCity.findOne({
                where: { active: true, name: { [Op.iLike]: userCtxForFeed.city } },
                attributes: ['id'],
                raw: true,
            });
            if (city?.id) {
                assignmentOrConds.push({ scopeType: 'CITY', scopeValue: String(city.id) });
            }
        }

        const myAssignments = await db.AcademyTrackAssignment.findAll({
            where: {
                createdAt: { [Op.gte]: since },
                [Op.or]: assignmentOrConds,
            },
            attributes: ['trackSlug', 'mandatory', 'dueAt', 'createdAt'],
            raw: true,
        });
        if (myAssignments.length) {
            const assignedSlugs = [...new Set(myAssignments.map(a => a.trackSlug))];
            const tracks = await db.AcademyTrack.findAll({
                where: { slug: { [Op.in]: assignedSlugs }, status: 'PUBLISHED' },
                attributes: ['slug', 'title'],
                raw: true,
            });
            const titleBySlug = Object.fromEntries(tracks.map(t => [t.slug, t.title]));

            for (const a of myAssignments) {
                const title = titleBySlug[a.trackSlug];
                if (!title) continue;
                events.push({
                    type: 'TRACK_PUBLISHED',
                    timestamp: a.createdAt,
                    title: a.mandatory ? `Trilha obrigatória: ${title}` : `Nova trilha: ${title}`,
                    snippet: a.dueAt
                        ? `Prazo: ${new Date(a.dueAt).toLocaleDateString('pt-BR')}`
                        : '',
                    link: `/academy/tracks/${encodeURIComponent(a.trackSlug)}`,
                    ref: { kind: 'track', slug: a.trackSlug, mandatory: a.mandatory, dueAt: a.dueAt },
                    reason: 'assignment',
                });
            }
        }

        // ─── 5) Atividade de users seguidos
        if (followedUsers.length) {
            // 5a) artigos publicados por eles
            const theirArticles = await db.AcademyArticle.findAll({
                where: {
                    [Op.and]: [
                        {
                            createdByUserId: { [Op.in]: followedUsers },
                            status: 'PUBLISHED',
                            updatedAt: { [Op.gte]: since },
                        },
                        audWhere,
                    ],
                },
                attributes: ['id', 'title', 'slug', 'categorySlug', 'createdByUserId', 'updatedAt'],
                order: [['updatedAt', 'DESC']],
                limit: PER_SOURCE_LIMIT,
                raw: true,
            });
            for (const a of theirArticles) {
                events.push({
                    type: 'USER_ACTIVITY',
                    timestamp: a.updatedAt,
                    title: a.title,
                    snippet: 'Novo artigo publicado',
                    link: `/academy/kb/${encodeURIComponent(a.categorySlug)}/${encodeURIComponent(a.slug)}`,
                    ref: { kind: 'article', id: a.id, slug: a.slug, categorySlug: a.categorySlug },
                    authorId: a.createdByUserId,
                    reason: 'user-follow',
                });
            }

            // 5b) tópicos criados por eles
            const theirTopics = await db.AcademyTopic.findAll({
                where: {
                    [Op.and]: [
                        {
                            createdByUserId: { [Op.in]: followedUsers },
                            createdAt: { [Op.gte]: since },
                        },
                        audWhere,
                    ],
                },
                attributes: ['id', 'title', 'type', 'categorySlug', 'createdByUserId', 'createdAt'],
                order: [['createdAt', 'DESC']],
                limit: PER_SOURCE_LIMIT,
                raw: true,
            });
            for (const t of theirTopics) {
                events.push({
                    type: 'USER_ACTIVITY',
                    timestamp: t.createdAt,
                    title: t.title,
                    snippet: 'Novo tópico no fórum',
                    link: `/academy/community/topic/${t.id}`,
                    ref: { kind: 'topic', id: t.id, topicType: t.type },
                    authorId: t.createdByUserId,
                    reason: 'user-follow',
                });
            }
        }

        // ─── 6) Anexa username dos autores (batch)
        const authorIds = [...new Set(events.map(e => e.authorId).filter(Boolean))];
        let nameById = {};
        if (authorIds.length) {
            const users = await db.User.findAll({
                where: { id: { [Op.in]: authorIds } },
                attributes: ['id', 'username'],
                raw: true,
            });
            nameById = Object.fromEntries(users.map(u => [u.id, u.username]));
        }
        for (const e of events) {
            if (e.authorId && nameById[e.authorId]) e.authorName = nameById[e.authorId];
        }

        // ─── 7) Ordena cronologicamente DESC, deduplica por link
        events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        const seen = new Set();
        const dedup = [];
        for (const e of events) {
            const key = `${e.type}:${e.link}`;
            if (seen.has(key)) continue;
            seen.add(key);
            dedup.push(e);
        }

        // ─── 8) Pagina
        const safePage = Math.max(1, Number(page) || 1);
        const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
        const offset = (safePage - 1) * safePageSize;
        const paged = dedup.slice(offset, offset + safePageSize);

        return {
            page: safePage,
            pageSize: safePageSize,
            total: dedup.length,
            results: paged,
        };
    },
};

export default feedService;

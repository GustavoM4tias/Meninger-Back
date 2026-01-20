// services/academy/meService.js
import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

function normalizeAudience(a) {
    return ['BOTH', 'GESTOR_ONLY', 'ADM_ONLY'].includes(a) ? a : 'BOTH';
}

function audienceWhere(a) {
    if (a === 'BOTH') return { audience: { [Op.in]: ['BOTH', 'GESTOR_ONLY', 'ADM_ONLY'] } };
    return { audience: { [Op.in]: ['BOTH', a] } };
}

const meService = {
    async getSummary({ userId, audience }) {
        if (!userId) throw new Error('Usuário não identificado.');

        const finalAudience = normalizeAudience(audience);

        const user = await db.User.findByPk(userId, {
            attributes: ['id', 'username', 'email', 'position', 'city', 'role', 'status', 'createdAt', 'last_login'],
        });

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

        const tracksCompleted = trackRows.filter(r => r.status === 'COMPLETED').length;
        const tracksInProgress = trackRows.filter(r => r.status === 'IN_PROGRESS').length;

        // ✅ lookup do title por slug
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

        return {
            audience: finalAudience,
            user: user ? user.toJSON() : null,
            kb: { drafts: kbDrafts, published: kbPublished, total: kbDrafts + kbPublished },
            community: { topicsCreated, answersPosted },
            tracks: { completed: tracksCompleted, inProgress: tracksInProgress, list },
        };
    },
};

export default meService;

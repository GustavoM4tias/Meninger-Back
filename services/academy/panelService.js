import db from '../../models/sequelize/index.js';

const DEFAULT_LIMIT = 6;

function normalizeAudience(audience) {
    const allowed = new Set(['BOTH', 'GESTOR_ONLY', 'ADM_ONLY']);
    return allowed.has(audience) ? audience : 'BOTH';
}

const panelService = {
    async getSummary({ userId, audience }) {
        const finalAudience = normalizeAudience(audience);

        // Se modelos ainda não existem, devolve payload consistente
        if (!db.AcademyArticle || !db.AcademyTopic || !db.AcademyUserTrackProgress) {
            return {
                audience: finalAudience,
                kbUpdates: [],
                openQuestions: [],
                tracksInProgress: [],
                highlights: [],
            };
        }

        // 1) KB updates
        const kbUpdates = await db.AcademyArticle.findAll({
            where: {
                status: 'PUBLISHED',
                ...(finalAudience === 'BOTH'
                    ? { audience: ['BOTH', 'GESTOR_ONLY', 'ADM_ONLY'] }
                    : { audience: ['BOTH', finalAudience] }),
            },
            attributes: ['id', 'title', 'slug', 'categorySlug', 'updatedAt'],
            order: [['updatedAt', 'DESC']],
            limit: DEFAULT_LIMIT,
        });

        // 2) Open questions
        const openQuestions = await db.AcademyTopic.findAll({
            where: {
                type: 'QUESTION',
                status: 'OPEN',
                acceptedPostId: null,
                ...(finalAudience === 'BOTH'
                    ? { audience: ['BOTH', 'GESTOR_ONLY', 'ADM_ONLY'] }
                    : { audience: ['BOTH', finalAudience] }),
            },
            attributes: ['id', 'title', 'tags', 'createdAt'],
            order: [['createdAt', 'DESC']],
            limit: DEFAULT_LIMIT,
        });

        // 3) Tracks in progress (se userId existir)
        const tracksInProgress = userId
            ? await db.AcademyUserTrackProgress.findAll({
                where: { userId, status: 'IN_PROGRESS' },
                attributes: ['trackSlug', 'progressPercent', 'updatedAt'],
                order: [['updatedAt', 'DESC']],
                limit: DEFAULT_LIMIT,
            })
            : [];

        // 4) Highlights (fixos)
        const highlights = await db.AcademyHighlight.findAll({
            where: {
                active: true,
                ...(finalAudience === 'BOTH'
                    ? { audience: ['BOTH', 'GESTOR_ONLY', 'ADM_ONLY'] }
                    : { audience: ['BOTH', finalAudience] }),
            },
            attributes: ['title', 'type', 'target', 'priority'],
            order: [['priority', 'ASC']],
            limit: DEFAULT_LIMIT,
        });

        return {
            audience: finalAudience,
            kbUpdates,
            openQuestions,
            tracksInProgress,
            highlights,
        };
    }
};

export default panelService;

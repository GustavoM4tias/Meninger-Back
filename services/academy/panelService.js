import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { resolveUserTokens, audiencesWhereLiteral } from './audience.js';

const DEFAULT_LIMIT = 6;

const panelService = {
    async getSummary({ userId }) {
        // Se modelos ainda não existem, devolve payload consistente
        if (!db.AcademyArticle || !db.AcademyTopic || !db.AcademyUserTrackProgress) {
            return {
                kbUpdates: [],
                openQuestions: [],
                tracksInProgress: [],
                highlights: [],
            };
        }

        const tokens = await resolveUserTokens(userId);
        const audWhere = audiencesWhereLiteral(tokens);

        // 1) KB updates
        const kbUpdates = await db.AcademyArticle.findAll({
            where: {
                [Op.and]: [{ status: 'PUBLISHED' }, audWhere],
            },
            attributes: ['id', 'title', 'slug', 'categorySlug', 'updatedAt'],
            order: [['updatedAt', 'DESC']],
            limit: DEFAULT_LIMIT,
        });

        // 2) Open questions
        const openQuestions = await db.AcademyTopic.findAll({
            where: {
                [Op.and]: [
                    { type: 'QUESTION', status: 'OPEN', acceptedPostId: null },
                    audWhere,
                ],
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
                [Op.and]: [{ active: true }, audiencesWhereLiteral(tokens)],
            },
            attributes: ['title', 'type', 'target', 'priority'],
            order: [['priority', 'ASC']],
            limit: DEFAULT_LIMIT,
        });

        return {
            tokens,
            kbUpdates,
            openQuestions,
            tracksInProgress,
            highlights,
        };
    }
};

export default panelService;

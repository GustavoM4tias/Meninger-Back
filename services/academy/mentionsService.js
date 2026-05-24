// services/academy/mentionsService.js
//
// Extrai e resolve menções "@username" em corpo de posts/comentários.
//
// Regex: @ seguido de [a-zA-Z0-9._-]+ com 3+ chars (alinhar com regra de
// username do User do projeto — VARCHAR(50)). Limite no comprimento via 1..50.
//
// Resolução é tolerante: usernames inexistentes são ignorados (não falha o post).
// Retorna apenas usernames que existem como User ativo.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';

const MENTION_RE = /(?:^|[^a-zA-Z0-9_])@([a-zA-Z0-9._-]{3,50})\b/g;

// Limite de menções por mensagem (anti-spam)
const MAX_MENTIONS_PER_MESSAGE = 10;

function extractUsernamesFromText(body) {
    if (!body || typeof body !== 'string') return [];
    const found = new Set();
    let m;
    while ((m = MENTION_RE.exec(body)) !== null) {
        const u = String(m[1] || '').trim();
        if (u) found.add(u);
        if (found.size >= MAX_MENTIONS_PER_MESSAGE) break;
    }
    return [...found];
}

const mentionsService = {
    // Extrai apenas (sem persistir, sem notificar).
    extractUsernames(body) {
        return extractUsernamesFromText(body);
    },

    /**
     * Resolve menções no texto → lista de {id, username} de users válidos.
     * Ignora username inexistentes / inativos.
     */
    async resolveMentions(body) {
        const usernames = extractUsernamesFromText(body);
        if (!usernames.length) return [];

        const users = await db.User.findAll({
            where: {
                username: { [Op.in]: usernames },
                status: true,
            },
            attributes: ['id', 'username'],
            raw: true,
        });
        return users;
    },

    /**
     * Lookup para autocomplete @ no frontend.
     * Devolve até `limit` usuários cujo username começa com q.
     */
    async lookup({ q, limit = 8 }) {
        const term = String(q || '').trim();
        if (term.length < 1) return { results: [] };

        const safeLimit = Math.min(20, Math.max(1, Number(limit) || 8));

        const rows = await db.User.findAll({
            where: {
                username: { [Op.iLike]: `${term}%` },
                status: true,
            },
            attributes: ['id', 'username', 'position'],
            order: [['username', 'ASC']],
            limit: safeLimit,
            raw: true,
        });
        return { results: rows };
    },

    /**
     * Dispara notification para cada user mencionado (exceto o próprio autor).
     * `context`: { kind: 'topic'|'article'|'post', refId, refLink, refTitle, snippet }
     */
    async notifyMentioned({ body, authorUserId, context = {} }) {
        try {
            const mentioned = await mentionsService.resolveMentions(body);
            if (!mentioned.length) return [];

            const targetIds = mentioned
                .map(u => Number(u.id))
                .filter(id => Number.isFinite(id) && id !== Number(authorUserId));

            if (!targetIds.length) return mentioned;

            await NotificationService.notify({
                type: NotificationType.ACADEMY_MENTIONED,
                recipients: { users: targetIds },
                title: `Você foi mencionado em ${context.refTitle || 'uma conversa'}`,
                body: context.snippet || 'Alguém citou seu @ em uma mensagem.',
                data: {
                    kind: context.kind || 'post',
                    refId: context.refId || null,
                    refLink: context.refLink || null,
                },
                link: context.refLink || '/academy/community',
                importance: 5,
            });

            return mentioned;
        } catch (err) {
            console.warn('[academy.mentions.notify] failed', err?.message);
            return [];
        }
    },
};

export default mentionsService;

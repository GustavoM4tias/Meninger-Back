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

// ─────────────────────────────────────────────────────────────────────────
// ESCOPO DE MENÇÃO — quem `actor` pode mencionar (decidido com o usuário).
//
//   - admin                    → todos
//   - interno (Office)         → todos os internos ativos, EXCETO protegidos
//                                (mentionable=false). Não alcança externos.
//   - corretor (BROKER)        → corretores da MESMA organização
//   - imobiliária (REALESTATE) → sua organização (seus corretores + imob)
//   - correspondente           → correspondentes da MESMA organização
//   - externo sem organização  → ninguém
//
// Retorna:
//   { all: true }            → admin (sem filtro de público)
//   { where: {...} }         → cláusula Sequelize de User a ser mesclada
//   { none: true }           → não pode mencionar ninguém
//
// É a ÚNICA fonte de verdade: usada tanto no autocomplete (`lookup`) quanto
// na resolução real (`resolveMentions`), que é onde a regra de fato é imposta
// (o autocomplete é só UX — alguém poderia digitar @fulano na unha).
// ─────────────────────────────────────────────────────────────────────────
async function resolveMentionScope(actorUserId) {
    const uid = Number(actorUserId);
    if (!Number.isFinite(uid) || uid <= 0) return { none: true };

    const actor = await db.User.findByPk(uid, {
        attributes: ['id', 'role', 'auth_provider', 'external_kind', 'external_organization_id'],
        raw: true,
    });
    if (!actor) return { none: true };

    if (actor.role === 'admin') return { all: true };

    const provider = String(actor.auth_provider || 'INTERNAL').toUpperCase();
    const kind = String(actor.external_kind || '').toUpperCase();
    const isExternal = provider === 'CVCRM' || !!kind;

    // Interno comum: todos os internos ativos, menos os protegidos.
    if (!isExternal) {
        return {
            where: {
                external_kind: { [Op.is]: null },
                auth_provider: { [Op.ne]: 'CVCRM' },
                mentionable: true,
            },
        };
    }

    // Externo: só faz sentido dentro da própria organização.
    const orgId = actor.external_organization_id;
    if (!orgId) return { none: true };

    if (kind === 'BROKER') {
        return { where: { external_organization_id: orgId, external_kind: 'BROKER', mentionable: true } };
    }
    if (kind === 'REALESTATE') {
        // imobiliária enxerga seus corretores (e contas imob da mesma org)
        return {
            where: {
                external_organization_id: orgId,
                external_kind: { [Op.in]: ['BROKER', 'REALESTATE'] },
                mentionable: true,
            },
        };
    }
    if (kind === 'CORRESPONDENT') {
        return { where: { external_organization_id: orgId, external_kind: 'CORRESPONDENT', mentionable: true } };
    }

    return { none: true }; // tipo externo desconhecido
}

const mentionsService = {
    // Extrai apenas (sem persistir, sem notificar).
    extractUsernames(body) {
        return extractUsernamesFromText(body);
    },

    // Exposto para testes/uso externo.
    resolveMentionScope,

    /**
     * Resolve menções no texto → lista de {id, username} de users válidos
     * QUE `actorUserId` pode mencionar (aplica o escopo de relação). Esta é a
     * imposição real da regra — usernames fora do escopo são silenciosamente
     * descartados (não viram link nem notificação).
     */
    async resolveMentions(body, { actorUserId = null } = {}) {
        const usernames = extractUsernamesFromText(body);
        if (!usernames.length) return [];

        const scope = await resolveMentionScope(actorUserId);
        if (scope.none) return [];

        const where = {
            username: { [Op.in]: usernames },
            status: true,
        };
        if (!scope.all) Object.assign(where, scope.where);

        const users = await db.User.findAll({
            where,
            attributes: ['id', 'username'],
            raw: true,
        });
        return users;
    },

    /**
     * Lookup para autocomplete @ no frontend, JÁ filtrado pelo escopo de quem
     * está digitando (`actorUserId`). Devolve até `limit` usuários cujo username
     * começa com q.
     */
    async lookup({ q, limit = 8, actorUserId = null }) {
        const term = String(q || '').trim();
        if (term.length < 1) return { results: [] };

        const safeLimit = Math.min(20, Math.max(1, Number(limit) || 8));

        const scope = await resolveMentionScope(actorUserId);
        if (scope.none) return { results: [] };

        const where = {
            username: { [Op.iLike]: `${term}%` },
            status: true,
        };
        if (!scope.all) Object.assign(where, scope.where);
        // Nunca sugerir o próprio usuário.
        if (Number(actorUserId) > 0) where.id = { [Op.ne]: Number(actorUserId) };

        const rows = await db.User.findAll({
            where,
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
            // Aplica o escopo do AUTOR — só notifica quem ele pode mencionar.
            const mentioned = await mentionsService.resolveMentions(body, { actorUserId: authorUserId });
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

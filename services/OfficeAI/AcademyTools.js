// services/OfficeAI/AcademyTools.js
//
// Tools que o Eme oferece sobre o Menin Academy (estudos).
// Disponíveis nos DOIS contextos (ACADEMY E OFFICE) — qualquer user
// autenticado pode usar. Não há dados sensíveis aqui — só estudos.
//
// Princípios:
//   - SEMPRE filtra por tokens do user (resolveUserTokens).
//   - SEMPRE filtra resultados pelos assignments do user (não vaza track
//     atribuída a outro perfil).
//   - NÃO inclui correctIndexes de quiz (sempre stripado).
//   - Limita resultados (top 20) para não estourar contexto do modelo.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { registerTool } from './ToolRegistry.js';
import { resolveUserTokens, audiencesWhereLiteral } from '../academy/audience.js';
import gamificationService from '../academy/gamificationService.js';

const MAX_RESULTS = 20;

// ─── kb_search ─────────────────────────────────────────────────────────
registerTool({
    name: 'academy_kb_search',
    description: 'Busca artigos da base de conhecimento (Knowledge Base) do Menin Academy. Retorna apenas artigos PUBLICADOS dentro da audience do usuário. Use quando o usuário pergunta como fazer algo, procura um procedimento ou material de estudo.',
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Termo de busca livre (texto, palavras-chave).' },
            categorySlug: { type: 'string', description: 'Filtro opcional por slug da categoria (ex: "vendas", "marketing").' },
        },
        required: ['query'],
    },
    requiredPermissions: [],
    contexts: ['ACADEMY', 'OFFICE'],
    async handler(user, args) {
        const q = String(args?.query || '').trim();
        const categorySlug = args?.categorySlug ? String(args.categorySlug).trim() : null;
        if (!q) return { result: { results: [], message: 'Forneça um termo de busca.' } };

        const tokens = await resolveUserTokens(user.id);
        const andClauses = [
            { status: 'PUBLISHED' },
            audiencesWhereLiteral(tokens),
            {
                [Op.or]: [
                    { title: { [Op.iLike]: `%${q}%` } },
                    { body: { [Op.iLike]: `%${q}%` } },
                ],
            },
        ];
        if (categorySlug) andClauses.push({ categorySlug });

        const rows = await db.AcademyArticle.findAll({
            where: { [Op.and]: andClauses },
            attributes: ['id', 'title', 'slug', 'categorySlug', 'updatedAt'],
            order: [['updatedAt', 'DESC']],
            limit: MAX_RESULTS,
            raw: true,
        });

        return {
            result: {
                results: rows.map(r => ({
                    title: r.title,
                    category: r.categorySlug,
                    link: `/academy/kb/${encodeURIComponent(r.categorySlug)}/${encodeURIComponent(r.slug)}`,
                    updatedAt: r.updatedAt,
                })),
            },
            resultCount: rows.length,
            resultIds: rows.map(r => r.id),
            filtersApplied: { tokens, categorySlug },
        };
    },
});

// ─── list_my_tracks ────────────────────────────────────────────────────
registerTool({
    name: 'academy_list_my_tracks',
    description: 'Lista as trilhas de aprendizagem atribuídas ao usuário, com progresso atual e estado (bloqueada por pré-requisito, em andamento, concluída). Use quando o usuário pergunta "quais trilhas tenho", "o que devo estudar", "minhas trilhas".',
    parameters: {
        type: 'object',
        properties: {
            onlyMandatory: { type: 'boolean', description: 'Se true, retorna apenas trilhas obrigatórias (mandatory=true).' },
        },
    },
    requiredPermissions: [],
    contexts: ['ACADEMY', 'OFFICE'],
    async handler(user, args) {
        const onlyMandatory = args?.onlyMandatory === true;

        // Reusa trackService.listTracks (que já cobre tudo: audience + assignments + lock)
        const trackService = (await import('../academy/trackService.js')).default;
        const data = await trackService.listTracks({ userId: user.id });
        let results = data?.results || [];

        if (onlyMandatory) {
            // listTracks não devolve mandatory direto — temos que filtrar via assignments USER do user.
            const myAssigns = await db.AcademyTrackAssignment.findAll({
                where: {
                    scopeType: 'USER',
                    scopeValue: String(user.id),
                    mandatory: true,
                },
                attributes: ['trackSlug', 'dueAt'],
                raw: true,
            });
            const mandSlugs = new Set(myAssigns.map(a => a.trackSlug));
            const dueBySlug = Object.fromEntries(myAssigns.map(a => [a.trackSlug, a.dueAt]));
            results = results
                .filter(t => mandSlugs.has(t.slug))
                .map(t => ({ ...t, dueAt: dueBySlug[t.slug] }));
        }

        return {
            result: {
                results: results.slice(0, MAX_RESULTS).map(t => ({
                    title: t.title,
                    slug: t.slug,
                    progressPercent: t.progressPercent || 0,
                    locked: !!t.locked,
                    blockedBy: t.blockedBy?.map(b => b.title || b.slug) || [],
                    link: `/academy/tracks/${encodeURIComponent(t.slug)}`,
                    dueAt: t.dueAt || null,
                })),
            },
            resultCount: results.length,
            filtersApplied: { onlyMandatory },
        };
    },
});

// ─── next_recommended ──────────────────────────────────────────────────
registerTool({
    name: 'academy_next_recommended',
    description: 'Recomenda o PRÓXIMO item de estudo do usuário. Prioriza: 1) trilhas obrigatórias em atraso, 2) próximos itens não-concluídos das trilhas em andamento, 3) novas trilhas atribuídas. Use quando o usuário pergunta "o que estudar agora", "por onde começar".',
    parameters: {
        type: 'object',
        properties: {},
    },
    requiredPermissions: [],
    contexts: ['ACADEMY', 'OFFICE'],
    async handler(user) {
        const trackService = (await import('../academy/trackService.js')).default;
        const data = await trackService.listTracks({ userId: user.id });
        const tracks = data?.results || [];

        // Mandatory + dueAt mais próximo
        const myAssigns = await db.AcademyTrackAssignment.findAll({
            where: { scopeType: 'USER', scopeValue: String(user.id), mandatory: true },
            attributes: ['trackSlug', 'dueAt'],
            raw: true,
        });
        const dueBySlug = Object.fromEntries(myAssigns.map(a => [a.trackSlug, a.dueAt]));

        // Score simples: mandatory + dueAt próximo = mais alto
        const scored = tracks
            .filter(t => !t.locked && (t.progressPercent || 0) < 100)
            .map(t => {
                const due = dueBySlug[t.slug];
                const dueDays = due ? Math.max(0, Math.floor((new Date(due).getTime() - Date.now()) / 86400000)) : null;
                let score = 0;
                if (due) score += 1000 / Math.max(1, dueDays + 1); // quanto mais perto, maior
                score += (t.progressPercent || 0); // empurra trilha já iniciada
                return { ...t, dueAt: due, dueDays, _score: score };
            })
            .sort((a, b) => b._score - a._score);

        const top = scored[0];
        if (!top) {
            return {
                result: {
                    message: 'Você está em dia! Não há trilhas pendentes no momento. Que tal explorar a base de conhecimento?',
                    suggestions: [],
                },
                resultCount: 0,
            };
        }

        return {
            result: {
                title: top.title,
                slug: top.slug,
                progressPercent: top.progressPercent || 0,
                dueAt: top.dueAt || null,
                dueDays: top.dueDays,
                link: `/academy/tracks/${encodeURIComponent(top.slug)}`,
                reason: top.dueAt
                    ? `Trilha obrigatória — prazo ${top.dueDays} dia(s).`
                    : (top.progressPercent > 0 ? 'Continuar de onde parou.' : 'Próxima trilha sugerida.'),
            },
            resultCount: 1,
            resultIds: [top.slug],
        };
    },
});

// ─── my_xp_stats ───────────────────────────────────────────────────────
registerTool({
    name: 'academy_my_xp_stats',
    description: 'Retorna XP, nível, streak de dias consecutivos e badges conquistados pelo usuário no Academy. Use quando o usuário pergunta "quanto XP tenho", "qual meu nível", "minhas conquistas".',
    parameters: { type: 'object', properties: {} },
    requiredPermissions: [],
    contexts: ['ACADEMY', 'OFFICE'],
    async handler(user) {
        const stats = await gamificationService.getStats({ userId: user.id });
        const badges = await gamificationService.listUserBadges({ userId: user.id });
        return {
            result: {
                level: stats.level,
                totalXp: stats.totalXp,
                xpToNextLevel: stats.xpToNextLevel,
                currentStreak: stats.currentStreak,
                longestStreak: stats.longestStreak,
                badgeCount: badges.results.length,
                recentBadges: badges.results.slice(0, 5).map(b => ({
                    title: b.title,
                    rarity: b.rarity,
                    awardedAt: b.awardedAt,
                })),
            },
            resultCount: badges.results.length,
        };
    },
});

// ─── overview ──────────────────────────────────────────────────────────
registerTool({
    name: 'academy_overview',
    description: 'Panorama REAL do conteúdo do Academy disponível para este usuário: categorias da base de conhecimento e trilhas existentes, com contagens. Use quando o usuário pergunta de forma genérica "o que tem para estudar", "quais assuntos/temas existem", "o que posso aprender", ou sempre que precisar saber o que de fato existe antes de recomendar algo. NUNCA invente categorias ou trilhas — chame esta ferramenta.',
    parameters: { type: 'object', properties: {} },
    requiredPermissions: [],
    contexts: ['ACADEMY', 'OFFICE'],
    async handler(user) {
        const tokens = await resolveUserTokens(user.id);

        // Categorias REAIS da KB — derivadas dos artigos publicados na audience.
        const articleRows = await db.AcademyArticle.findAll({
            where: {
                [Op.and]: [{ status: 'PUBLISHED' }, audiencesWhereLiteral(tokens)],
            },
            attributes: ['categorySlug'],
            raw: true,
        });
        const catCount = {};
        for (const r of articleRows) {
            const slug = r.categorySlug || 'sem-categoria';
            catCount[slug] = (catCount[slug] || 0) + 1;
        }
        const categories = Object.entries(catCount)
            .map(([slug, articleCount]) => ({
                slug,
                label: slug.split('-').filter(Boolean)
                    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
                articleCount,
                link: `/academy/kb/${encodeURIComponent(slug)}`,
            }))
            .sort((a, b) => b.articleCount - a.articleCount);

        // Trilhas visíveis ao usuário (trackService cobre audience + assignments).
        const trackService = (await import('../academy/trackService.js')).default;
        const data = await trackService.listTracks({ userId: user.id });
        const tracks = (data?.results || []).slice(0, MAX_RESULTS).map(t => ({
            title: t.title,
            slug: t.slug,
            progressPercent: t.progressPercent || 0,
            locked: !!t.locked,
            link: `/academy/tracks/${encodeURIComponent(t.slug)}`,
        }));

        const empty = categories.length === 0 && tracks.length === 0;
        return {
            result: {
                categories,
                tracks,
                totals: {
                    articles: articleRows.length,
                    categories: categories.length,
                    tracks: tracks.length,
                },
                message: empty
                    ? 'Ainda não há conteúdo publicado disponível para este usuário.'
                    : 'Estas são as categorias e trilhas REAIS disponíveis. Use somente estes itens — não invente outros.',
            },
            resultCount: categories.length + tracks.length,
            filtersApplied: { tokens },
        };
    },
});

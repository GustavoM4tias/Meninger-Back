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
import { departmentWhereForUser } from '../academy/departmentVisibility.js';
import gamificationService from '../academy/gamificationService.js';
import academyRetrieval from '../academy/academyRetrievalService.js';

const MAX_RESULTS = 20;

// Formata digests de processos como TEXTO compacto para o MODELO ler. O
// summarizeForGemini do chat REMOVE arrays do resultado — por isso entregamos
// os digests como texto (não array) ao Gemini. É a base da resposta grounded
// e econômica (digests curtos em vez do corpo).
function formatProcessList(items) {
    if (!Array.isArray(items) || !items.length) return '';
    return items.map((p, i) => {
        const L = [`[${i + 1}] ${p.title}${p.slug ? ` (slug: ${p.slug})` : ''}`];
        if (p.category) L.push(`Categoria: ${p.category}${p.subcategory ? ` › ${p.subcategory}` : ''}`);
        if (p.resumo) L.push(`Resumo: ${p.resumo}`);
        if (p.processFor?.length) L.push(`Atende: ${p.processFor.join('; ')}`);
        if (p.prerequisites?.length) L.push(`Pré-requisitos: ${p.prerequisites.join('; ')}`);
        if (p.systems?.length) L.push(`Sistemas: ${p.systems.join(', ')}`);
        if (p.link) L.push(`Link: ${p.link}`);
        if (p.videoUrl) L.push(`Vídeo (YouTube): ${p.videoUrl}`);
        return L.join('\n');
    }).join('\n\n');
}

// ── Cards (frontend) — estrutura flexível p/ o ChatAcademyCards.vue ─────────
// Vão no `action` (SSE) e são REMOVIDOS do contexto do modelo (summarizeForGemini
// corta arrays); o modelo continua lendo o campo de texto (`processos`/etc.).
const CAT_CONN = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
function catLabel(category, subcategory) {
    if (!category) return undefined;
    const h = (s) => String(s || '').split('-')
        .map((w, i) => (i > 0 && CAT_CONN.has(w)) ? w : w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    return subcategory ? `${h(category)} › ${h(subcategory)}` : h(category);
}

function processCards(items) {
    return (items || []).map((p) => ({
        icon: 'fa-solid fa-diagram-project',
        tone: 'accent',
        title: p.title,
        category: catLabel(p.category, p.subcategory),
        subtitle: p.resumo || undefined,
        badges: (p.systems || []).slice(0, 5),
        sections: (p.prerequisites && p.prerequisites.length)
            ? [{ label: 'Pré-requisitos', items: p.prerequisites.slice(0, 6) }]
            : [],
        link: p.link,
        linkLabel: 'Abrir processo',
        videoUrl: p.videoUrl || undefined,
    }));
}

function certCards(items, fmtDate) {
    return (items || []).map((c) => ({
        icon: 'fa-solid fa-award',
        tone: c.displayStatus === 'ACTIVE' ? 'emerald' : (c.displayStatus === 'REVOKED' ? 'rose' : 'amber'),
        title: c.trackTitle,
        subtitle: `Emitido em ${fmtDate(c.issuedAt)}${c.expiresAt ? ` · validade ${fmtDate(c.expiresAt)}` : ''}`,
        badges: [c.displayStatus],
        link: `/academy/cert/${encodeURIComponent(c.code)}`,
        linkLabel: 'Ver certificado',
    }));
}

function topicCards(items) {
    return (items || []).map((t) => ({
        icon: 'fa-solid fa-comments',
        tone: t.acceptedPostId ? 'emerald' : 'slate',
        title: t.title,
        subtitle: t.acceptedPostId ? 'Respondido' : (t.status === 'OPEN' ? 'Em aberto' : t.status),
        badges: [t.type, t.status].filter(Boolean),
        link: `/academy/community/topic/${t.id}`,
        linkLabel: 'Abrir discussão',
    }));
}

// ─── kb_search ─────────────────────────────────────────────────────────
registerTool({
    name: 'academy_kb_search',
    description: 'Busca PROCESSOS/procedimentos e artigos da base de conhecimento do Academy. Retorna RESUMOS (digests) dos mais relevantes — o que é, para que serve, CATEGORIA e pré-requisitos. Use quando o usuário pergunta como fazer algo, procura um procedimento ou quer entender um processo. Chame TAMBÉM quando o pedido é REFINADO — nunca responda sobre um processo de memória nem invente nome de processo. Para o passo-a-passo completo, depois chame academy_get_process com o slug.',
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Termo de busca livre (tema, ação, processo).' },
            categorySlug: { type: 'string', description: 'Filtro opcional por slug da categoria (ex: "procedimentos", "comercial").' },
        },
        required: ['query'],
    },
    requiredPermissions: [],
    contexts: ['ACADEMY', 'OFFICE'],
    async handler(user, args) {
        const q = String(args?.query || '').trim();
        const categorySlug = args?.categorySlug ? String(args.categorySlug).trim() : null;
        if (!q) return { result: { results: [], message: 'Forneça um termo de busca.' } };

        const { results, count } = await academyRetrieval.searchProcesses({
            query: q, userId: user.id, k: 6, categorySlug,
        });

        const out = {
            processos: formatProcessList(results),
            message: count
                ? 'Resumos dos processos no campo "processos". ESCOLHA o(s) que REALMENTE correspondem ao pedido (confira "Resumo" e "Atende" — alguns podem ser só relacionados, não exatamente o pedido; ex.: "Reserva Direta - sem Pré-Cadastro" NÃO é o tutorial de pré-cadastro) e destaque-os primeiro. Se um processo tiver "Vídeo (YouTube)", use EXATAMENTE aquela URL — NUNCA invente link de vídeo (se não houver, diga que não há). Responda só a partir deles, citando os links. Para o passo-a-passo, use academy_get_process com o slug.'
                : 'Nenhum processo encontrado dentro do que o usuário pode ver. Diga isso com clareza — não invente.',
        };
        if (count) {
            out.type = 'academy_cards';
            out.title = 'Processos encontrados';
            out.cards = processCards(results);
        }
        return { result: out, resultCount: count };
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
        const deptWhere = await departmentWhereForUser(user.id);

        // Categorias REAIS da KB — derivadas dos artigos publicados na audience.
        const articleRows = await db.AcademyArticle.findAll({
            where: {
                [Op.and]: [{ status: 'PUBLISHED' }, audiencesWhereLiteral(tokens), deptWhere],
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

// ─── get_process ───────────────────────────────────────────────────────
// Abre o CONTEÚDO (passo-a-passo) de um processo pelo slug — só quando o
// resumo não basta. Economia: corpo/seção sob demanda, truncado.
registerTool({
    name: 'academy_get_process',
    description: 'Abre o CONTEÚDO (passo-a-passo / detalhes) de um processo/procedimento específico pelo slug retornado por academy_kb_search. Use SOMENTE quando o resumo não bastar e o usuário precisar dos detalhes. Pode pedir uma seção específica (ex: "documentos necessários").',
    parameters: {
        type: 'object',
        properties: {
            slug: { type: 'string', description: 'Slug do artigo/processo (vem de academy_kb_search).' },
            section: { type: 'string', description: 'Opcional: título/trecho de uma seção específica.' },
        },
        required: ['slug'],
    },
    requiredPermissions: [],
    contexts: ['ACADEMY', 'OFFICE'],
    async handler(user, args) {
        const slug = String(args?.slug || '').trim();
        if (!slug) return { result: { found: false, message: 'Informe o slug do processo.' } };
        const data = await academyRetrieval.getProcess({
            slug, userId: user.id, section: args?.section || null,
        });
        if (!data.found) {
            // Fallback: busca pelo texto do slug — ajuda quando o modelo passou slug errado
            // (não chama getProcess de novo; retorna os digests diretamente da busca).
            const query = slug.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
            const fb = await academyRetrieval.searchProcesses({ query, userId: user.id, k: 3 });
            if (fb.count) {
                return {
                    result: {
                        found: false,
                        processos: formatProcessList(fb.results),
                        message: `Slug "${slug}" não encontrado. Processos mais próximos abaixo — verifique qual corresponde (veja "Resumo"/"Atende"), use o slug correto em academy_get_process para o passo-a-passo, ou responda com base nos resumos.`,
                        type: 'academy_cards',
                        title: 'Processos relacionados',
                        cards: processCards(fb.results),
                    },
                    resultCount: fb.count,
                };
            }
            return { result: { found: false, message: 'Processo não encontrado ou fora do seu acesso.' }, resultCount: 0 };
        }
        return {
            result: {
                type: 'academy_cards',
                title: data.title,
                cards: [{
                    icon: 'fa-solid fa-book-open',
                    tone: 'accent',
                    title: data.title,
                    category: catLabel(data.category),
                    subtitle: data.section ? `Seção: ${data.section}` : 'Processo completo',
                    link: data.link,
                    linkLabel: 'Abrir artigo',
                    videoUrl: data.videoUrl || undefined,
                }],
                conteudo: data.content,
                video: data.videoUrl || null,
                secao: data.section || null,
                truncado: data.truncated,
                message: 'Conteúdo no campo "conteudo"; o link do vídeo (se houver) está em "video" — use EXATAMENTE essa URL, NUNCA invente link de vídeo. Resuma a partir do conteúdo e cite o link. Não invente etapas.',
            },
            resultCount: 1,
        };
    },
});

// ─── process_requirements ──────────────────────────────────────────────
// "O que preciso para a ação X" — indica os processos necessários + pré-reqs.
registerTool({
    name: 'academy_process_requirements',
    description: 'Dada uma AÇÃO/objetivo (ex: "cadastrar fornecedor", "pagar reembolso", "registrar contrato"), indica QUAIS processos são necessários, com seus pré-requisitos e sistemas. Use quando o usuário pergunta "o que preciso para fazer X", "quais processos para X", "por onde começo para X".',
    parameters: {
        type: 'object',
        properties: {
            action: { type: 'string', description: 'A ação/objetivo do usuário, em linguagem natural.' },
        },
        required: ['action'],
    },
    requiredPermissions: [],
    contexts: ['ACADEMY', 'OFFICE'],
    async handler(user, args) {
        const action = String(args?.action || '').trim();
        if (!action) return { result: { processes: [], message: 'Descreva a ação.' } };
        const data = await academyRetrieval.processRequirements({ action, userId: user.id, k: 6 });
        const out = {
            action: data.action,
            processos: formatProcessList(data.processes),
            message: data.count
                ? 'Os processos necessários para a ação estão no campo "processos", com pré-requisitos e sistemas. Liste-os na ordem e cite os links; para o passo-a-passo use academy_get_process. Não afirme nada fora destes resultados.'
                : 'Não encontrei processos cadastrados para essa ação no que o usuário pode ver. Diga isso — não invente.',
        };
        if (data.count) {
            out.type = 'academy_cards';
            out.title = `O que você precisa para: ${data.action}`;
            out.cards = processCards(data.processes);
        }
        return { result: out, resultCount: data.count };
    },
});

// ─── my_certificates ───────────────────────────────────────────────────
registerTool({
    name: 'academy_my_certificates',
    description: 'Lista os certificados de conclusão do usuário no Academy (trilha, data de emissão, validade, status). Use quando o usuário pergunta "meus certificados", "que certificados eu tenho", "validade do meu certificado", "concluí a trilha X?".',
    parameters: { type: 'object', properties: {} },
    requiredPermissions: [],
    contexts: ['ACADEMY', 'OFFICE'],
    async handler(user) {
        const certificateService = (await import('../academy/certificateService.js')).default;
        const { results } = await certificateService.listMine({ userId: user.id });
        const fmtDate = (d) => { try { return new Date(d).toLocaleDateString('pt-BR'); } catch { return String(d || ''); } };
        const text = (results || []).map((c, i) => {
            const val = c.expiresAt ? `validade ${fmtDate(c.expiresAt)}` : 'sem expiração';
            return `[${i + 1}] ${c.trackTitle} — ${c.displayStatus} (emitido ${fmtDate(c.issuedAt)}, ${val}) — código ${c.code} — /academy/cert/${encodeURIComponent(c.code)}`;
        }).join('\n');
        const out = {
            certificados: text,
            total: results?.length || 0,
            message: results?.length
                ? 'Certificados do usuário no campo "certificados". Cite trilha, status e o link; não invente certificados.'
                : 'O usuário ainda não tem certificados emitidos. Diga isso com clareza — não invente.',
        };
        if (results?.length) {
            out.type = 'academy_cards';
            out.title = 'Seus certificados';
            out.cards = certCards(results, fmtDate);
        }
        return { result: out, resultCount: results?.length || 0 };
    },
});

// ─── community_search ──────────────────────────────────────────────────
// Comunidade está em STANDBY no MVP (oculta no menu), mas os tópicos existem —
// a Eme pode surfacear o Q&A entre colegas. Filtra por audience.
registerTool({
    name: 'academy_community_search',
    description: 'Busca tópicos da Comunidade do Academy (perguntas, discussões e respostas entre colegas). Use quando o usuário pergunta "alguém já perguntou sobre X", "tem discussão sobre Y", "dúvidas da comunidade sobre Z" ou quer ver perguntas em aberto.',
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Termo de busca (assunto, palavra-chave).' },
            onlyOpen: { type: 'boolean', description: 'Se true, só perguntas em aberto (status OPEN).' },
        },
    },
    requiredPermissions: [],
    contexts: ['ACADEMY', 'OFFICE'],
    async handler(user, args) {
        const communityService = (await import('../academy/communityService.js')).default;
        const q = String(args?.query || '').trim();
        const data = await communityService.listTopics({
            type: undefined,
            q,
            status: args?.onlyOpen ? 'OPEN' : undefined,
            userId: user.id,
            page: 1,
            pageSize: 8,
        });
        const items = (data?.results || []);
        const text = items.map((t, i) => {
            const resp = t.acceptedPostId ? ', respondido' : '';
            return `[${i + 1}] ${t.title} (${t.type}, ${t.status}${resp}) — /academy/community/topic/${t.id}`;
        }).join('\n');
        const out = {
            topicos: text,
            total: data?.total || items.length,
            message: items.length
                ? 'Tópicos da comunidade no campo "topicos". Cite títulos e links; para o conteúdo da discussão, oriente a abrir o link. Não invente tópicos.'
                : 'Nenhum tópico encontrado na comunidade para essa busca. Diga isso — não invente.',
        };
        if (items.length) {
            out.type = 'academy_cards';
            out.title = 'Comunidade';
            out.cards = topicCards(items);
        }
        return { result: out, resultCount: items.length };
    },
});

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';
import gamificationService from './gamificationService.js';
import {
    normalizeAudiences,
    deriveLegacyAudience,
    resolveUserTokens,
    normalizeVisibility,
    visibilityToAudiences,
    canonicalizeAudiences,
    deriveVisibility,
} from './audience.js';
import { normalizeDepartmentIds } from './departmentVisibility.js';
import academyDigestService from './academyDigestService.js';

/**
 * Resolve usuários que devem ser notificados pelo conjunto de audiences do
 * artigo. Aplica a mesma lógica de `resolveUserTokens(user)` mas em lote:
 * varre usuários ativos e mantém apenas os que TÊM tokens que cruzam com o
 * `audiences` do artigo. Como o cruzamento é por interseção, o admin sempre
 * recebe (ele tem todos os tokens).
 */
async function resolveAudienceUserIds(audiences) {
    const targetSet = new Set(normalizeAudiences(audiences));
    if (!targetSet.size) return [];

    const users = await db.User.findAll({
        where: { status: true },
        attributes: ['id'],
        raw: true,
    });

    const matchedIds = [];
    // Sequencial mas leve: resolveUserTokens faz 1 query por user. Para volumes
    // grandes, otimizar com lookup de role/position/auth_provider em batch.
    for (const u of users) {
        // eslint-disable-next-line no-await-in-loop
        const tokens = await resolveUserTokens(u.id);
        if (tokens.some(t => targetSet.has(t))) matchedIds.push(Number(u.id));
    }
    return matchedIds;
}

// S2.4: cria snapshot da versão ATUAL antes de qualquer mudança no artigo.
async function snapshotVersion(article, { userId, message = null } = {}) {
    if (!article) return null;

    // calcula próximo versionNumber: max + 1
    const last = await db.AcademyArticleVersion.max('versionNumber', { where: { articleId: article.id } });
    const versionNumber = (Number(last) || 0) + 1;

    return db.AcademyArticleVersion.create({
        articleId: article.id,
        versionNumber,
        title: article.title,
        slug: article.slug,
        categorySlug: article.categorySlug,
        body: article.body || '',
        payload: article.payload || null,
        wasPublished: article.status === 'PUBLISHED',
        createdByUserId: userId || article.updatedByUserId || article.createdByUserId || null,
        message: message ? String(message).trim().slice(0, 240) : null,
    });
}

async function notifyArticlePublished(article) {
    try {
        if (!article || article.status !== 'PUBLISHED') return;
        // Notifica TODOS os usuários cujo tokens cruzam com as audiences do artigo.
        const userIds = await resolveAudienceUserIds(article.audiences);
        if (!userIds.length) return;

        await NotificationService.notify({
            type: NotificationType.ACADEMY_ARTICLE_PUBLISHED,
            recipients: { users: userIds },
            title: `Novo artigo: ${article.title}`,
            body: 'Um novo artigo da base de conhecimento está disponível.',
            data: { articleSlug: article.slug, categorySlug: article.categorySlug },
            link: `/academy/kb/${encodeURIComponent(article.categorySlug)}/${encodeURIComponent(article.slug)}`,
            importance: 3,
        });
    } catch (err) {
        console.warn('[academy.kb.notifyArticlePublished] failed', err?.message);
    }
}

function kebab(s) {
    return String(s || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

function normalizeStatus(status) {
    const s = String(status || '').toUpperCase();
    return (s === 'DRAFT' || s === 'PUBLISHED') ? s : '';
}

function asJsonOrNull(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return v;
    throw new Error('payload inválido (deve ser objeto).');
}

// Apelidos para o auto-link estilo wiki. Tolerante (string solta vira []).
// Limites: cada apelido até 80 chars, máximo 20 apelidos, deduplica por
// case-insensitive preservando a forma original do primeiro.
function normalizeAliases(input) {
    if (!Array.isArray(input)) return [];
    const out = [];
    const seen = new Set();
    for (const item of input) {
        const s = String(item ?? '').trim();
        if (!s) continue;
        if (s.length > 80) continue;
        const key = s.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
        if (out.length >= 20) break;
    }
    return out;
}

// Modelo de 4 classes: `visibility` (INTERNAL|EXTERNAL|BOTH|ADMIN) tem
// prioridade; um array `audiences` legado é canonicalizado para uma das 4
// classes. Sem nada informado → INTERNO (padrão seguro: nunca vaza p/ externo).
function resolveAudiencesForWrite(input, visibility) {
    const vis = normalizeVisibility(visibility);
    if (vis) return visibilityToAudiences(vis);
    const arr = normalizeAudiences(input);
    if (!arr.length) return visibilityToAudiences('INTERNAL');
    return canonicalizeAudiences(arr);
}

// Normaliza a lista de editores: ids inteiros positivos, únicos, máx. 50.
function normalizeEditorUserIds(input) {
    if (!Array.isArray(input)) return [];
    const seen = new Set();
    const out = [];
    for (const item of input) {
        const n = Number(item);
        if (!Number.isInteger(n) || n <= 0) continue;
        if (seen.has(n)) continue;
        seen.add(n);
        out.push(n);
        if (out.length >= 50) break;
    }
    return out;
}

// Pode editar? Admin OU autor OU consta em editorUserIds.
function canEditArticle(article, userId, isAdmin) {
    if (isAdmin) return true;
    const uid = Number(userId);
    if (!uid) return false;
    if (Number(article.createdByUserId) === uid) return true;
    const editors = Array.isArray(article.editorUserIds) ? article.editorUserIds.map(Number) : [];
    return editors.includes(uid);
}

function forbidden(message) {
    const err = new Error(message);
    err.status = 403;
    return err;
}

async function uniqueSlug({ baseSlug, ignoreId = null }) {
    let slug = baseSlug || 'artigo';
    let i = 1;

    while (true) {
        const where = { slug };
        if (ignoreId) where.id = { [db.Sequelize.Op.ne]: ignoreId };

        const exists = await db.AcademyArticle.findOne({ where, attributes: ['id'] });
        if (!exists) return slug;

        i += 1;
        slug = `${baseSlug}-${i}`;
    }
}

const kbAdminService = {
    async listMine({ userId, q, status, page, pageSize }) {
        if (!userId) throw new Error('Usuário não identificado.');

        const finalStatus = normalizeStatus(status);

        const safePage = Math.max(1, Number(page) || 1);
        const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
        const offset = (safePage - 1) * safePageSize;

        const where = { createdByUserId: userId };

        if (finalStatus) where.status = finalStatus;

        if (q && String(q).trim()) {
            const like = `%${String(q).trim()}%`;
            where[Op.or] = [
                { title: { [Op.iLike]: like } },
                { body: { [Op.iLike]: like } },
            ];
        }

        const { rows, count } = await db.AcademyArticle.findAndCountAll({
            where,
            attributes: [
                'id',
                'title',
                'slug',
                'categorySlug',
                'subcategorySlug',
                'status',
                'audiences',
                'createdByUserId',
                'updatedByUserId',
                'createdAt',
                'updatedAt',
            ],
            order: [['updatedAt', 'DESC']],
            limit: safePageSize,
            offset,
        });

        return { page: safePage, pageSize: safePageSize, total: count, results: rows };
    },

    async getById(id) {
        const article = await db.AcademyArticle.findByPk(id, {
            attributes: [
                'id',
                'title',
                'slug',
                'categorySlug',
                'subcategorySlug',
                'body',
                'payload',
                'aliases',
                'audiences',
                'audience',
                'editorUserIds',
                'departmentIds',
                'status',
                'createdByUserId',
                'updatedByUserId',
                'createdAt',
                'updatedAt',
            ],
        });
        if (!article) return article;

        // Resolve os editores para o picker do editor (id + username + cargo).
        const ids = normalizeEditorUserIds(article.editorUserIds);
        let editors = [];
        if (ids.length) {
            editors = await db.User.findAll({
                where: { id: { [Op.in]: ids } },
                attributes: ['id', 'username', 'position'],
                raw: true,
            });
        }
        const json = article.toJSON();
        json.editorUserIds = ids;
        json.editors = editors;
        json.visibility = deriveVisibility(json.audiences); // classe derivada p/ o editor
        return json;
    },

    async create({ userId, title, categorySlug, body, payload, aliases, audiences, visibility, editorUserIds, subcategorySlug, departmentIds }) {
        const baseSlug = kebab(title);
        const slug = await uniqueSlug({ baseSlug });

        const aud = resolveAudiencesForWrite(audiences, visibility);

        const article = await db.AcademyArticle.create({
            title: String(title).trim(),
            categorySlug: String(categorySlug).trim(),
            subcategorySlug: subcategorySlug ? kebab(subcategorySlug) : null,
            slug,
            body: String(body || ''),
            payload: asJsonOrNull(payload),
            aliases: normalizeAliases(aliases),
            audiences: aud,
            audience: deriveLegacyAudience(aud),
            editorUserIds: normalizeEditorUserIds(editorUserIds),
            departmentIds: normalizeDepartmentIds(departmentIds),
            status: 'DRAFT',
            createdByUserId: userId || null,
            updatedByUserId: userId || null,
        });

        return article;
    },

    // Candidatos a editor: usuários INTERNOS ativos (externos não editam KB).
    async searchEditorCandidates({ q = '', excludeUserId = null } = {}) {
        const term = String(q || '').trim();
        const where = {
            status: true,
            external_kind: { [Op.is]: null },
            auth_provider: { [Op.ne]: 'CVCRM' },
        };
        if (excludeUserId) where.id = { [Op.ne]: Number(excludeUserId) };
        if (term) {
            where[Op.or] = [
                { username: { [Op.iLike]: `%${term}%` } },
                { email: { [Op.iLike]: `%${term}%` } },
                { position: { [Op.iLike]: `%${term}%` } },
            ];
        }
        const rows = await db.User.findAll({
            where,
            attributes: ['id', 'username', 'position'],
            order: [['username', 'ASC']],
            limit: 20,
            raw: true,
        });
        return { results: rows };
    },

    async update(id, { userId, title, categorySlug, body, payload, aliases, audiences, visibility, editorUserIds, subcategorySlug, departmentIds, isAdmin = false, versionMessage = null }) {
        const article = await db.AcademyArticle.findByPk(id);
        if (!article) throw new Error('Artigo não encontrado.');

        // 🔒 Permissão de edição: admin OU autor OU editor selecionado.
        if (!canEditArticle(article, userId, isAdmin)) {
            throw forbidden('Você não tem permissão para editar este artigo.');
        }

        // editorUserIds é OPCIONAL — undefined = não alterar. Apenas o autor e
        // admins podem REDEFINIR a lista de editores (um editor não promove outros).
        const canManageEditors = isAdmin || Number(article.createdByUserId) === Number(userId);
        const nextEditorIds = (editorUserIds === undefined || !canManageEditors)
            ? undefined
            : normalizeEditorUserIds(editorUserIds);
        const editorsChanged = nextEditorIds !== undefined &&
            JSON.stringify(nextEditorIds) !== JSON.stringify(normalizeEditorUserIds(article.editorUserIds));

        // S2.4: detecta se algo MATERIAL mudou — se sim, snapshot da versão atual
        // ANTES de aplicar o update. Mudanças irrelevantes (re-save sem alteração)
        // não geram versão pra evitar lixo no histórico.
        const nextCategory = String(categorySlug).trim();
        const nextTitle = String(title).trim();
        const nextBody = String(body || '');
        const nextPayload = asJsonOrNull(payload);
        // aliases é OPCIONAL — undefined = não alterar; array = atualizar.
        const nextAliases = aliases === undefined ? undefined : normalizeAliases(aliases);
        const aliasesChanged = nextAliases !== undefined &&
            JSON.stringify(nextAliases) !== JSON.stringify(article.aliases || []);

        // visibility (4 classes) OU audiences (legado) disparam a troca de público;
        // ambos ausentes = não alterar.
        const wantsAudienceChange = visibility !== undefined || audiences !== undefined;
        const nextAudiences = wantsAudienceChange ? resolveAudiencesForWrite(audiences, visibility) : undefined;
        const audiencesChanged = nextAudiences !== undefined &&
            JSON.stringify(nextAudiences) !== JSON.stringify(article.audiences || []);

        // subcategoria é OPCIONAL — undefined = não alterar; '' = limpar.
        const nextSubcategory = subcategorySlug === undefined
            ? undefined
            : (subcategorySlug ? kebab(subcategorySlug) : null);
        const subcategoryChanged = nextSubcategory !== undefined &&
            nextSubcategory !== (article.subcategorySlug || null);

        // departmentIds (visibilidade interna) é OPCIONAL — undefined = não alterar.
        const nextDepartmentIds = departmentIds === undefined ? undefined : normalizeDepartmentIds(departmentIds);

        const changed =
            nextCategory !== article.categorySlug ||
            nextTitle !== article.title ||
            nextBody !== (article.body || '') ||
            JSON.stringify(nextPayload) !== JSON.stringify(article.payload || null) ||
            aliasesChanged ||
            audiencesChanged ||
            subcategoryChanged ||
            editorsChanged;

        if (changed) {
            await snapshotVersion(article, { userId, message: versionMessage });
        }

        let nextSlug = article.slug;
        const changedKey =
            nextCategory !== article.categorySlug ||
            nextTitle !== article.title;

        if (changedKey) {
            const baseSlug = kebab(nextTitle);
            nextSlug = await uniqueSlug({ baseSlug, ignoreId: article.id });
        }

        const fields = {
            title: nextTitle,
            categorySlug: nextCategory,
            slug: nextSlug,
            body: nextBody,
            payload: nextPayload,
            updatedByUserId: userId || article.updatedByUserId || null,
        };
        if (nextAliases !== undefined) fields.aliases = nextAliases;
        if (nextAudiences !== undefined) {
            fields.audiences = nextAudiences;
            fields.audience = deriveLegacyAudience(nextAudiences);
        }
        if (nextEditorIds !== undefined) fields.editorUserIds = nextEditorIds;
        if (nextSubcategory !== undefined) fields.subcategorySlug = nextSubcategory;
        if (nextDepartmentIds !== undefined) fields.departmentIds = nextDepartmentIds;

        await article.update(fields);

        return article;
    },

    // S2.4: lista versões do artigo (sem o body completo — pra economizar payload).
    async listVersions(id) {
        const rows = await db.AcademyArticleVersion.findAll({
            where: { articleId: Number(id) },
            attributes: ['id', 'versionNumber', 'title', 'categorySlug', 'wasPublished', 'message', 'createdByUserId', 'createdAt'],
            order: [['versionNumber', 'DESC']],
            include: [
                { model: db.User, as: 'createdBy', attributes: ['id', 'username', 'email'], required: false },
            ],
        });
        return { results: rows };
    },

    async getVersion(id, versionNumber) {
        const v = await db.AcademyArticleVersion.findOne({
            where: { articleId: Number(id), versionNumber: Number(versionNumber) },
        });
        if (!v) throw new Error('Versão não encontrada.');
        return { version: v.toJSON() };
    },

    // Restaura uma versão antiga → snapshot do estado atual + aplica conteúdo da versão.
    async restoreVersion(id, versionNumber, { userId } = {}) {
        const article = await db.AcademyArticle.findByPk(Number(id));
        if (!article) throw new Error('Artigo não encontrado.');

        const v = await db.AcademyArticleVersion.findOne({
            where: { articleId: article.id, versionNumber: Number(versionNumber) },
        });
        if (!v) throw new Error('Versão não encontrada.');

        // snapshot do estado atual antes de sobrescrever
        await snapshotVersion(article, {
            userId,
            message: `Auto-snapshot antes de restaurar versão ${v.versionNumber}`,
        });

        await article.update({
            title: v.title,
            categorySlug: v.categorySlug,
            slug: v.slug, // mantém slug histórico — outra versão pode ter mesmo título mas slug diferente
            body: v.body,
            payload: v.payload,
            updatedByUserId: userId || article.updatedByUserId || null,
        });

        return article;
    },

    async publish(id, publish, { userId, isAdmin = false } = {}) {
        const article = await db.AcademyArticle.findByPk(id);
        if (!article) throw new Error('Artigo não encontrado.');

        // 🔒 Mesma regra da edição: admin OU autor OU editor selecionado.
        if (!canEditArticle(article, userId, isAdmin)) {
            throw forbidden('Você não tem permissão para publicar/despublicar este artigo.');
        }

        const wasPublished = article.status === 'PUBLISHED';

        await article.update({
            status: publish ? 'PUBLISHED' : 'DRAFT',
            updatedByUserId: userId || article.updatedByUserId || null,
        });

        // Eme × Processos: ao publicar, gera/atualiza digest + embedding (async,
        // não bloqueia; idempotente por digest_hash). É a base da busca da Eme.
        if (publish) {
            academyDigestService.ensureForArticle(article)
                .catch(err => console.warn('[academy.kb.publish] digest failed', err?.message));
        }

        // Notifica apenas na transição DRAFT→PUBLISHED (não em re-publish nem em despublish).
        if (publish && !wasPublished) {
            notifyArticlePublished(article)
                .catch(err => console.warn('[academy.kb.publish] notify failed', err?.message));

            // S5.1: XP por publicar artigo (1ª vez — idempotente por articleId)
            const authorId = Number(article.createdByUserId);
            if (authorId) {
                gamificationService.awardXp({
                    userId: authorId,
                    reason: 'ARTICLE_PUBLISHED',
                    refKind: 'article',
                    refId: String(article.id),
                }).catch(err => console.warn('[gamification.articlePublished]', err?.message));
            }
        }

        return article;
    },
};

export default kbAdminService;

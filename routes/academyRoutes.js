// api/routes/academyRoutes.js
import express from 'express';
import panelController from '../controllers/academy/panelController.js';
import kbController from '../controllers/academy/kbController.js';
import communityController from '../controllers/academy/communityController.js';
import trackController from '../controllers/academy/trackController.js';
import kbAdminController from '../controllers/academy/kbAdminController.js';
import meController from '../controllers/academy/meController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireInternal from '../middlewares/requireInternal.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import trackAdminController from '../controllers/academy/trackAdminController.js';
import trackAssignmentController from '../controllers/academy/trackAssignmentController.js';
import academyAdminMetaController from '../controllers/academy/academyAdminMetaController.js';
import highlightAdminController from '../controllers/academy/highlightAdminController.js';
import certificateController from '../controllers/academy/certificateController.js';
import moduleAdminController from '../controllers/academy/moduleAdminController.js';
import questionBankController from '../controllers/academy/questionBankController.js';
import prerequisiteController from '../controllers/academy/prerequisiteController.js';
import analyticsController from '../controllers/academy/analyticsController.js';
import followController from '../controllers/academy/followController.js';
import mentionsController from '../controllers/academy/mentionsController.js';
import articleCommentsController from '../controllers/academy/articleCommentsController.js';
import ratingsController from '../controllers/academy/ratingsController.js';
import feedController from '../controllers/academy/feedController.js';
import gamificationController from '../controllers/academy/gamificationController.js';
import onboardingController from '../controllers/academy/onboardingController.js';
import { externalRequestCode, externalVerifyCode } from '../controllers/academy/authExternalController.js';
import { generateArticle } from '../services/academy/kbGenerateService.js';
import db from '../models/sequelize/index.js';

const router = express.Router();

// ========= PUBLIC (sem token) - login externo =========
router.post('/external/request', externalRequestCode);
router.post('/external/verify', externalVerifyCode);

// ========= PUBLIC (sem token) - verificação de certificado =========
// URL é colada no QR code: qualquer pessoa pode confirmar autenticidade.
router.get('/cert/verify/:code', certificateController.verify);
router.get('/cert/pdf/:code', certificateController.downloadPdf);

// ========= MIXTO (interno + externo) =========
// ✅ remover requireInternal daqui
router.get('/panel/summary', authenticate, panelController.getSummary);

router.get('/me/summary', authenticate, meController.getSummary);
router.get('/users/rank', authenticate, meController.rank);
router.get('/users/lookup', authenticate, mentionsController.lookup);
router.get('/users/:id(\\d+)/summary', authenticate, meController.summary);

router.get('/kb/categories', authenticate, kbController.listCategories);
router.get('/kb/articles', authenticate, kbController.listArticles);
router.get('/kb/articles/:categorySlug/:articleSlug', authenticate, kbController.getArticle);

// ── Backlinks ("Mencionado em") ──────────────────────────────────────────────
// Lista artigos publicados que linkam para este artigo (texto do body contém
// `/academy/kb/cat/slug`). Útil pra mostrar no rodapé da leitura.
router.get('/kb/articles/:categorySlug/:articleSlug/backlinks', authenticate, async (req, res) => {
    try {
        const { categorySlug, articleSlug } = req.params;
        const cat = String(categorySlug || '').trim();
        const sl = String(articleSlug || '').trim();
        if (!cat || !sl) return res.json({ backlinks: [] });

        const pattern = `%/academy/kb/${encodeURIComponent(cat)}/${encodeURIComponent(sl)}%`;
        const rows = await db.AcademyArticle.findAll({
            where: {
                status: 'PUBLISHED',
                body: { [db.Sequelize.Op.iLike]: pattern },
            },
            attributes: ['slug', 'categorySlug', 'title', 'updatedAt'],
            order: [['updatedAt', 'DESC']],
            limit: 50,
        });

        const backlinks = rows
            .filter((r) => !(r.categorySlug === cat && r.slug === sl))
            .map((r) => ({
                slug: r.slug,
                categorySlug: r.categorySlug,
                title: r.title || '',
                updatedAt: r.updatedAt,
            }));

        res.json({ backlinks });
    } catch (err) {
        console.error('[kb/backlinks] error:', err);
        res.status(500).json({ error: 'Erro ao buscar menções.' });
    }
});

// Gera um trecho curto, sem markdown, para preview no hover de um link
// interno (`[texto](/academy/kb/cat/slug)`). Ignora o primeiro `# Título`,
// tira embeds, mantém só a essência textual.
function makeKbSnippet(body) {
    if (!body) return '';
    const NL = String.fromCharCode(10);
    let s = String(body);
    const firstNL = s.indexOf(NL);
    if (firstNL > 0 && /^\s*#\s+/.test(s.slice(0, firstNL))) {
        s = s.slice(firstNL + 1);
    }
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');         // imagens
    s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');      // [link](url) → link
    s = s.replace(/@\[[A-Z_]+:[^\]]+\]/g, '');          // embeds @[X:y]
    s = s.replace(/^#{1,6}\s+/gm, '');                  // demais headings
    s = s.replace(/[*_`>~]+/g, '');                     // ênfase / blockquote
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > 220) s = s.slice(0, 220).trim() + '…';
    return s;
}

// ── Índice de links de artigos — alimenta o picker "Vincular artigo" no
// editor e o preview no hover de links internos no TokenRenderer.
router.get('/kb/link-index', authenticate, async (req, res) => {
    try {
        const rows = await db.AcademyArticle.findAll({
            where: { status: 'PUBLISHED' },
            attributes: ['slug', 'categorySlug', 'title', 'body', 'aliases', 'updatedAt'],
            order: [['updatedAt', 'DESC']],
            limit: 1000,
        });
        res.json({
            results: rows.map((r) => ({
                slug: r.slug,
                categorySlug: r.categorySlug,
                title: r.title || '',
                snippet: makeKbSnippet(r.body),
                aliases: Array.isArray(r.aliases) ? r.aliases : [],
                updatedAt: r.updatedAt,
            })),
        });
    } catch (err) {
        console.error('[kb/link-index] error:', err);
        res.status(500).json({ error: 'Erro ao carregar índice de links.' });
    }
});

// S4.1: Comentários em artigos
router.get('/kb/articles/:articleId(\\d+)/comments', authenticate, articleCommentsController.list);
router.post('/kb/articles/:articleId(\\d+)/comments', authenticate, articleCommentsController.create);
router.patch('/kb/comments/:commentId(\\d+)', authenticate, articleCommentsController.update);
router.delete('/kb/comments/:commentId(\\d+)', authenticate, articleCommentsController.remove);

// S4.2: Ratings 5★ (polimórfico ARTICLE | TRACK)
router.get('/ratings', authenticate, ratingsController.stats);
router.get('/ratings/reviews', authenticate, ratingsController.listReviews);
router.post('/ratings', authenticate, ratingsController.rate);
router.delete('/ratings', authenticate, ratingsController.removeMine);

router.get('/community/topics', authenticate, communityController.listTopics);
router.post('/community/topics', authenticate, communityController.createTopic);
router.get('/community/topics/:id', authenticate, communityController.getTopic);
router.post('/community/topics/:id/posts', authenticate, communityController.createPost);
router.patch('/community/topics/:id/accept/:postId', authenticate, communityController.acceptPost);
router.patch('/community/topics/:id/close', authenticate, communityController.closeTopic);
router.patch('/community/topics/:id/reopen', authenticate, communityController.reopenTopic);
router.get('/community/topics/my', authenticate, communityController.listMyTopics);

// S4.4: Follow polimórfico (USER | TRACK | TOPIC | CATEGORY)
router.post('/follow', authenticate, followController.follow);
router.post('/unfollow', authenticate, followController.unfollow);
router.get('/me/follows', authenticate, followController.listMine);

// S4.5: Feed personalizado
router.get('/me/feed', authenticate, feedController.getMyFeed);

// S5.1: Gamificação — XP + Badges
router.get('/me/xp', authenticate, gamificationController.myStats);
router.get('/me/badges', authenticate, gamificationController.myBadges);
router.get('/users/:userId(\\d+)/xp', authenticate, gamificationController.userStats);
router.get('/users/:userId(\\d+)/badges', authenticate, gamificationController.userBadges);

// S5.3: Onboarding (admin)
router.get('/admin/onboarding', authenticate, requireInternal, requireAdmin, onboardingController.list);
router.post('/admin/onboarding', authenticate, requireInternal, requireAdmin, onboardingController.create);
router.patch('/admin/onboarding/:id(\\d+)', authenticate, requireInternal, requireAdmin, onboardingController.update);
router.delete('/admin/onboarding/:id(\\d+)', authenticate, requireInternal, requireAdmin, onboardingController.remove);
router.post('/admin/onboarding/apply-now', authenticate, requireInternal, requireAdmin, onboardingController.applyNow);
router.get('/follow/count', authenticate, followController.followersCount);
router.get('/community/meta', authenticate, communityController.getMeta);

router.post('/community/posts/:postId(\\d+)/upvote', authenticate, communityController.upvotePost);
router.delete('/community/posts/:postId(\\d+)/upvote', authenticate, communityController.clearUpvote);

// Certificados (logado)
router.get('/cert/my', authenticate, certificateController.listMine);
router.get('/cert/:code', authenticate, certificateController.getByCode);

router.get('/tracks', authenticate, trackController.listTracks);
router.get('/tracks/:slug', authenticate, trackController.getTrack);
router.post('/tracks/:slug/opened', authenticate, trackController.markOpened);
router.post('/tracks/:slug/watch', authenticate, trackController.trackVideoWatch);
router.post('/tracks/:slug/progress', authenticate, trackController.markProgress);
router.post('/tracks/:slug/quiz', authenticate, trackController.submitQuiz);

// ========= INTERNAL ADMIN ONLY =========
// ✅ aqui sim entra requireInternal + requireAdmin
router.get('/kb/articles/my', authenticate, requireInternal, kbAdminController.listMine);
router.get('/kb/articles/:id(\\d+)', authenticate, requireInternal, kbAdminController.getById);
router.post('/kb/articles', authenticate, requireInternal, kbAdminController.create);
router.patch('/kb/articles/:id(\\d+)', authenticate, requireInternal, kbAdminController.update);
router.patch('/kb/articles/:id(\\d+)/publish', authenticate, requireInternal, kbAdminController.publish);

// S2.4: versionamento de artigos
router.get('/kb/articles/:id(\\d+)/versions', authenticate, requireInternal, kbAdminController.listVersions);
router.get('/kb/articles/:id(\\d+)/versions/:versionNumber(\\d+)', authenticate, requireInternal, kbAdminController.getVersion);
router.post('/kb/articles/:id(\\d+)/versions/:versionNumber(\\d+)/restore', authenticate, requireInternal, requireAdmin, kbAdminController.restoreVersion);

// ── Geração de artigos via IA (Gemini) — admin only ───────────────────────────
// Recebe {topic, context, style, categorySlug} e retorna {title, body,
// suggestedCategorySlug, model}. NÃO publica nada — só devolve a sugestão
// para o admin revisar/editar/publicar manualmente.
router.post('/kb/admin/articles/generate',
    authenticate, requireInternal, requireAdmin,
    async (req, res) => {
        try {
            const { topic, context, style, categorySlug } = req.body || {};
            const t = String(topic || '').trim();
            if (!t) return res.status(400).json({ error: 'topic obrigatório.' });
            if (t.length > 200) return res.status(400).json({ error: 'topic muito longo (máx. 200).' });
            const ctx = String(context || '').trim();
            if (ctx.length > 8000) return res.status(400).json({ error: 'context muito longo (máx. 8000).' });

            const out = await generateArticle({
                topic: t,
                context: ctx,
                style: ['procedimento', 'tutorial', 'faq', 'checklist'].includes(style) ? style : 'procedimento',
                categorySlug: String(categorySlug || '').trim(),
            });
            res.json(out);
        } catch (err) {
            console.error('[kbGenerate] error:', err);
            res.status(500).json({ error: err?.message || 'Erro ao gerar artigo com IA.' });
        }
    }
);

router.get('/tracks-admin', authenticate, requireInternal, requireAdmin, trackAdminController.list);
router.get('/tracks-admin/:slug', authenticate, requireInternal, requireAdmin, trackAdminController.get);
router.post('/tracks-admin', authenticate, requireInternal, requireAdmin, trackAdminController.create);
router.patch('/tracks-admin/:slug', authenticate, requireInternal, requireAdmin, trackAdminController.update);
router.patch('/tracks-admin/:slug/publish', authenticate, requireInternal, requireAdmin, trackAdminController.setPublish);
router.post('/tracks-admin/:slug/items', authenticate, requireInternal, requireAdmin, trackAdminController.addItem);
router.patch('/tracks-admin/:slug/items/:itemId', authenticate, requireInternal, requireAdmin, trackAdminController.updateItem);
router.delete('/tracks-admin/:slug/items/:itemId', authenticate, requireInternal, requireAdmin, trackAdminController.removeItem);
router.patch('/tracks-admin/:slug/items/reorder', authenticate, requireInternal, requireAdmin, trackAdminController.reorder);

router.get('/tracks-admin/:slug/assignments', authenticate, requireInternal, requireAdmin, trackAssignmentController.list);
router.post('/tracks-admin/:slug/assignments', authenticate, requireInternal, requireAdmin, trackAssignmentController.add);
router.delete('/tracks-admin/:slug/assignments/:id', authenticate, requireInternal, requireAdmin, trackAssignmentController.remove);
router.post('/tracks-admin/:slug/assignments/bulk', authenticate, requireInternal, requireAdmin, trackAssignmentController.bulkAdd);
router.get('/tracks-admin/:slug/adherence', authenticate, requireInternal, requireAdmin, trackAssignmentController.adherence);
router.get('/tracks-admin/:slug/adherence.xlsx', authenticate, requireInternal, requireAdmin, trackAssignmentController.adherenceXlsx);

// Modules admin (S2.1)
router.get('/tracks-admin/:slug/modules', authenticate, requireInternal, requireAdmin, moduleAdminController.list);
router.post('/tracks-admin/:slug/modules', authenticate, requireInternal, requireAdmin, moduleAdminController.create);
router.patch('/tracks-admin/:slug/modules/reorder', authenticate, requireInternal, requireAdmin, moduleAdminController.reorder);
router.patch('/tracks-admin/:slug/modules/:id(\\d+)', authenticate, requireInternal, requireAdmin, moduleAdminController.update);
router.delete('/tracks-admin/:slug/modules/:id(\\d+)', authenticate, requireInternal, requireAdmin, moduleAdminController.remove);
router.patch('/tracks-admin/:slug/items/:itemId(\\d+)/move', authenticate, requireInternal, requireAdmin, moduleAdminController.moveItem);

// Banco de questões (S2.2)
router.get('/admin/questions', authenticate, requireInternal, requireAdmin, questionBankController.list);
router.get('/admin/questions/:id(\\d+)', authenticate, requireInternal, requireAdmin, questionBankController.getById);
router.post('/admin/questions', authenticate, requireInternal, requireAdmin, questionBankController.create);
router.patch('/admin/questions/:id(\\d+)', authenticate, requireInternal, requireAdmin, questionBankController.update);
router.delete('/admin/questions/:id(\\d+)', authenticate, requireInternal, requireAdmin, questionBankController.archive);

// Ligação quiz item ↔ banco de questões
router.get('/admin/quiz-items/:itemId(\\d+)/questions', authenticate, requireInternal, requireAdmin, questionBankController.listByItem);
router.post('/admin/quiz-items/:itemId(\\d+)/questions', authenticate, requireInternal, requireAdmin, questionBankController.attach);
router.delete('/admin/quiz-items/:itemId(\\d+)/questions/:questionId(\\d+)', authenticate, requireInternal, requireAdmin, questionBankController.detach);

// S3.3: Pré-requisitos
router.get('/tracks-admin/:slug/prerequisites', authenticate, requireInternal, requireAdmin, prerequisiteController.list);
router.post('/tracks-admin/:slug/prerequisites', authenticate, requireInternal, requireAdmin, prerequisiteController.add);
router.delete('/tracks-admin/:slug/prerequisites/:id(\\d+)', authenticate, requireInternal, requireAdmin, prerequisiteController.remove);

// S3.4: Analytics de item
router.get('/tracks-admin/:slug/analytics', authenticate, requireInternal, requireAdmin, analyticsController.itemAnalytics);
router.delete('/tracks-admin/:slug', authenticate, requireInternal, requireAdmin, trackAdminController.remove);

router.get('/admin/meta', authenticate, requireInternal, requireAdmin, academyAdminMetaController.getMeta);
router.get('/admin/users', authenticate, requireInternal, requireAdmin, academyAdminMetaController.searchUsers);

// Certificado: revogar (admin)
router.delete('/admin/cert/:code', authenticate, requireInternal, requireAdmin, certificateController.revoke);

// Highlights admin
router.get('/admin/highlights', authenticate, requireInternal, requireAdmin, highlightAdminController.list);
router.get('/admin/highlights/:id(\\d+)', authenticate, requireInternal, requireAdmin, highlightAdminController.get);
router.post('/admin/highlights', authenticate, requireInternal, requireAdmin, highlightAdminController.create);
router.patch('/admin/highlights/reorder', authenticate, requireInternal, requireAdmin, highlightAdminController.reorder);
router.patch('/admin/highlights/:id(\\d+)', authenticate, requireInternal, requireAdmin, highlightAdminController.update);
router.patch('/admin/highlights/:id(\\d+)/active', authenticate, requireInternal, requireAdmin, highlightAdminController.setActive);
router.delete('/admin/highlights/:id(\\d+)', authenticate, requireInternal, requireAdmin, highlightAdminController.remove);

export default router;

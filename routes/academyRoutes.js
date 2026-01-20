// api/routes/academyRoutes.js
import express from 'express';
import panelController from '../controllers/academy/panelController.js';
import kbController from '../controllers/academy/kbController.js';
import communityController from '../controllers/academy/communityController.js';
import trackController from '../controllers/academy/trackController.js';
import kbAdminController from '../controllers/academy/kbAdminController.js';
import meController from '../controllers/academy/meController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import trackAdminController from '../controllers/academy/trackAdminController.js';
import trackAssignmentController from '../controllers/academy/trackAssignmentController.js';
import academyAdminMetaController from '../controllers/academy/academyAdminMetaController.js';

const router = express.Router();

router.get('/panel/summary', authenticate, panelController.getSummary);

router.get('/me/summary', authenticate, meController.getSummary);
router.get('/users/rank', authenticate, meController.rank);
router.get('/users/:id(\\d+)/summary', authenticate, meController.summary);

router.get('/kb/categories', authenticate, kbController.listCategories);
router.get('/kb/articles', authenticate, kbController.listArticles);
router.get('/kb/articles/my', authenticate, kbAdminController.listMine);
router.get('/kb/articles/:categorySlug/:articleSlug', authenticate, kbController.getArticle);
router.get('/kb/articles/:id(\\d+)', authenticate, kbAdminController.getById);
router.post('/kb/articles', authenticate, kbAdminController.create);
router.patch('/kb/articles/:id(\\d+)', authenticate, kbAdminController.update);
router.patch('/kb/articles/:id(\\d+)/publish', authenticate, kbAdminController.publish);

router.get('/community/topics', authenticate, communityController.listTopics);
router.post('/community/topics', authenticate, communityController.createTopic);
router.get('/community/topics/:id', authenticate, communityController.getTopic);
router.post('/community/topics/:id/posts', authenticate, communityController.createPost);
router.patch('/community/topics/:id/accept/:postId', authenticate, communityController.acceptPost);
router.patch('/community/topics/:id/close', authenticate, communityController.closeTopic);
router.patch('/community/topics/:id/reopen', authenticate, communityController.reopenTopic);
router.get('/community/meta', authenticate, communityController.getMeta);

router.get('/tracks', authenticate, trackController.listTracks);
router.get('/tracks/:slug', authenticate, trackController.getTrack);
router.post('/tracks/:slug/progress', authenticate, trackController.markProgress);
router.post('/tracks/:slug/quiz', authenticate, trackController.submitQuiz);

router.get('/tracks-admin', authenticate, requireAdmin, trackAdminController.list);
router.get('/tracks-admin/:slug', authenticate, requireAdmin, trackAdminController.get);
router.post('/tracks-admin', authenticate, requireAdmin, trackAdminController.create);
router.patch('/tracks-admin/:slug', authenticate, requireAdmin, trackAdminController.update);
router.patch('/tracks-admin/:slug/publish', authenticate, requireAdmin, trackAdminController.setPublish);
router.post('/tracks-admin/:slug/items', authenticate, requireAdmin, trackAdminController.addItem);
router.patch('/tracks-admin/:slug/items/:itemId', authenticate, requireAdmin, trackAdminController.updateItem);
router.delete('/tracks-admin/:slug/items/:itemId', authenticate, requireAdmin, trackAdminController.removeItem);
router.patch('/tracks-admin/:slug/items/reorder', authenticate, requireAdmin, trackAdminController.reorder);
router.get('/tracks-admin/:slug/assignments', authenticate, requireAdmin, trackAssignmentController.list);
router.post('/tracks-admin/:slug/assignments', authenticate, requireAdmin, trackAssignmentController.add);
router.delete('/tracks-admin/:slug/assignments/:id', authenticate, requireAdmin, trackAssignmentController.remove);
router.post('/tracks-admin/:slug/assignments/bulk', authenticate, requireAdmin, trackAssignmentController.bulkAdd);
router.delete('/tracks-admin/:slug', authenticate, requireAdmin, trackAdminController.remove);

router.get('/admin/meta', authenticate, requireAdmin, academyAdminMetaController.getMeta);
router.get('/admin/users', authenticate, requireAdmin, academyAdminMetaController.searchUsers);

export default router;

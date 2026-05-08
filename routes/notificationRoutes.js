// api/routes/notificationRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import {
    list,
    unreadCount,
    markRead,
    markAllRead,
    removeOne,
    getPreferences,
    setPreference,
} from '../controllers/notificationController.js';

const router = express.Router();

router.get('/',                   authenticate, list);
router.get('/unread-count',       authenticate, unreadCount);
router.get('/preferences',        authenticate, getPreferences);
router.put('/preferences',        authenticate, setPreference);
router.post('/read-all',          authenticate, markAllRead);
router.patch('/:id/read',         authenticate, markRead);
router.delete('/:id',             authenticate, removeOne);

export default router;

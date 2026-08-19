// api/routes/pushRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import {
    vapidKey,
    subscribe,
    unsubscribe,
    listDevices,
    removeDevice,
    test,
} from '../controllers/pushController.js';

const router = express.Router();

router.get('/vapid-key', authenticate, vapidKey);
router.get('/devices', authenticate, listDevices);
router.post('/subscribe', authenticate, subscribe);
router.post('/unsubscribe', authenticate, unsubscribe);
router.delete('/devices/:id', authenticate, removeDevice);
router.post('/test', authenticate, test);

export default router;

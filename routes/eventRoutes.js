// api/routes/eventRoutes.js
import express from 'express';
import { addEvent, getEvents, updateEvent, deleteEvent } from '../controllers/eventController.js';
import authenticate from '../middlewares/authMiddleware.js';
const router = express.Router();

router.post('/add', authenticate, addEvent);
router.get('/', authenticate, getEvents);
router.put('/edit/:id', authenticate, updateEvent);
router.delete('/delete/:id', authenticate, deleteEvent);

export default router;

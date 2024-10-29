// api/routes/eventRoutes.js
import express from 'express';
import { addEvent, getEvents, updateEvent, deleteEvent } from '../controllers/eventController.js';
import authenticate from '../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/add', authenticate, addEvent);
router.get('/', getEvents);    
router.put('/edit/:id', updateEvent); // Nova rota para edição de evento               
router.delete('/delete/:id', authenticate, deleteEvent); // Nova rota para exclusão de evento

export default router;

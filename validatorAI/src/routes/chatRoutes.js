// validatorAI/src/routes/chatRoutes.js
import express from 'express';
import { ChatService } from '../services/ChatService.js';

const router = express.Router();

// Chat genérico
router.post('/generic', async (req, res, next) => {
    try {
        const { prompt, message, model } = req.body;
        
        if (!message) {
            return res.status(400).json({ error: 'Mensagem é obrigatória.' });
        }

        const result = await ChatService.generic(message, prompt, model);
        res.json(result);
    } catch (err) {
        next(err);
    }
});

export { router as chatRoutes };
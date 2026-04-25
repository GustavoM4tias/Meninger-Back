// api/routes/eventRoutes.js
import express from 'express';
import axios from 'axios';
import { addEvent, getEvents, updateEvent, deleteEvent } from '../controllers/eventController.js';
import authenticate from '../middlewares/authMiddleware.js';
const router = express.Router();

router.post('/add', authenticate, addEvent);
router.get('/', authenticate, getEvents);
router.put('/edit/:id', authenticate, updateEvent);
router.delete('/delete/:id', authenticate, deleteEvent);

// Proxy para imagens externas (evita CORS do CRM no browser)
router.get('/proxy-image', authenticate, async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url obrigatória' });

    try {
        const decoded = decodeURIComponent(url);
        const response = await axios.get(decoded, {
            responseType: 'arraybuffer',
            timeout: 8000,
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });

        const contentType = response.headers['content-type'] || 'image/jpeg';
        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(response.data);
    } catch {
        res.status(502).json({ error: 'Falha ao buscar imagem' });
    }
});

export default router;

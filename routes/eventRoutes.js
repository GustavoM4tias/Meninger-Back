// api/routes/eventRoutes.js
import express from 'express';
import axios from 'axios';
import { addEvent, getEvents, updateEvent, deleteEvent, listReportRecipients, sendReportEmail } from '../controllers/eventController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireRoutePermission from '../middlewares/requireRoutePermission.js';
const router = express.Router();

// Alçada da tela de Eventos (admin bypassa no middleware).
const requireEvents = requireRoutePermission(['/marketing/events']);

router.post('/add', authenticate, requireEvents, addEvent);
router.get('/', authenticate, requireEvents, getEvents);
router.put('/edit/:id', authenticate, requireEvents, updateEvent);
router.delete('/delete/:id', authenticate, requireEvents, deleteEvent);

// Relatório por e-mail: catálogo de destinatários + envio.
router.get('/report/recipients', authenticate, requireEvents, listReportRecipients);
router.post('/report/email', authenticate, requireEvents, sendReportEmail);

// Proxy para imagens externas (evita CORS do CRM no browser)
router.get('/proxy-image', authenticate, requireEvents, async (req, res) => {
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

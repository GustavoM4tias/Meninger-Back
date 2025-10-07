// routes/supportRoutes.js
import { Router } from 'express';
import {
    createTicket,
    getTicket,
    addMessage,
    updateStatus,
    listTickets,
    countByStatus,
    statsOverview,
} from '../controllers/supportController.js';

import {
    authorizeByRole,    // você já possui
    // authorizeByPosition,
    // authorizeStrict,
    // filterByCity,
} from '../middlewares/permissionMiddleware.js';

import authenticate from '../middlewares/authMiddleware.js';

const r = Router();

/**
 * ORDEM IMPORTA:
 * - Específicas (counts/stats) antes
 * - Listagem
 * - Dinâmicas com :id por último e com regex numérica
 */

// contagens e estatísticas
r.get('/tickets/counts', countByStatus);
r.get('/stats', statsOverview);

// listagem (opcionalmente adicione algum filtro de escopo aqui se fizer sentido)
// r.get('/tickets', filterByCity, listTickets);
r.get('/tickets', listTickets);

// detalhe
r.get('/tickets/:id(\\d+)', getTicket);

// criar ticket (público/autenticado, conforme sua app)
r.post('/tickets', createTicket);

// responder (somente admin)
r.post('/tickets/:id(\\d+)/messages', authenticate, authorizeByRole(['admin']), addMessage);

// mudar status (somente admin)
r.patch('/tickets/:id(\\d+)/status', authenticate, authorizeByRole(['admin']), updateStatus);

export default r;

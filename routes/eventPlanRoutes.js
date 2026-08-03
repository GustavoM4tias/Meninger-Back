// routes/eventPlanRoutes.js
//
// Plano de Eventos — planejamento mensal de eventos comerciais.
// Uma tela só (/comercial/plano-eventos) com três visões conforme o papel.

import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireRoutePermission from '../middlewares/requireRoutePermission.js';
import * as ctrl from '../controllers/comercial/eventPlanController.js';

const router = express.Router();
router.use(authenticate);

// Configuração (admin-only no controller) e permissões do próprio usuário ficam
// fora do gate de alçada: settings já é admin, e /permissions só fala do
// solicitante — mesmo desenho das Fichas Comerciais.
router.get('/settings', ctrl.getSettings);
router.put('/settings', ctrl.updateSettings);
router.post('/auth-profiles', ctrl.upsertAuthProfile);
router.delete('/auth-profiles/:profileId(\\d+)', ctrl.deleteAuthProfile);
router.get('/users', ctrl.listUsers);
router.get('/permissions', ctrl.getMyPermissions);

// Itens previstos de um evento da agenda: consumido pela tela de Eventos, que é
// do Marketing. Aceita as duas alçadas — o escopo por empreendimento continua
// sendo conferido no controller.
router.get(
    '/by-event/:eventId(\\d+)',
    requireRoutePermission(['/comercial/plano-eventos', '/marketing/events']),
    ctrl.getByAgendaEvent
);

// Alçada de TELA: daqui para baixo tudo exige /comercial/plano-eventos liberado.
// Admin bypassa no middleware. O escopo por empreendimento (grant) é conferido
// dentro do controller, sempre fail-closed.
router.use(requireRoutePermission(['/comercial/plano-eventos']));

// Consolidado do mês (agenda unificada + lista de compras agrupada)
router.get('/consolidated', ctrl.getConsolidated);

// Planos
router.get('/', ctrl.listPlans);
router.post('/', ctrl.createPlan);
router.get('/:id(\\d+)', ctrl.getPlan);

// Eventos do plano
router.post('/:id(\\d+)/events', ctrl.createEvent);
router.patch('/:id(\\d+)/events/:eventId(\\d+)', ctrl.updateEvent);
router.delete('/:id(\\d+)/events/:eventId(\\d+)', ctrl.deleteEvent);

// Itens do evento
router.post('/:id(\\d+)/events/:eventId(\\d+)/items', ctrl.createItem);
router.patch('/:id(\\d+)/items/:itemId(\\d+)', ctrl.updateItem);
router.delete('/:id(\\d+)/items/:itemId(\\d+)', ctrl.deleteItem);

// Fluxo
router.post('/:id(\\d+)/submit', ctrl.submitPlan);   // gestor envia
router.post('/:id(\\d+)/decide', ctrl.decidePlan);   // lote de decisões da etapa
router.post('/:id(\\d+)/close', ctrl.closePlan);     // fecha o mês (congela)

export default router;

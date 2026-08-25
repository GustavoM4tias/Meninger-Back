// routes/assistantRoutes.js
//
// O assistente pessoal. Toda rota é da PRÓPRIA pessoa (o id sai do token), então
// não há alçada de tela a checar: não existe "ver a lista de tarefas de outro".
// É o mesmo desenho das preferências de notificação.
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import ctrl from '../controllers/assistant/PersonalAssistantController.js';

const router = express.Router();

router.get('/dia', authenticate, ctrl.meuDia);

router.get('/tarefas', authenticate, ctrl.tarefas);
router.post('/tarefas', authenticate, ctrl.criar);
router.patch('/tarefas/:id', authenticate, ctrl.atualizar);
router.post('/tarefas/:id/concluir', authenticate, ctrl.concluir);
router.post('/tarefas/:id/reabrir', authenticate, ctrl.reabrir);
router.post('/tarefas/:id/descartar', authenticate, ctrl.descartar);

// ── Subtarefas ────────────────────────────────────────────────────────────────
router.get('/tarefas/:id/itens', authenticate, ctrl.itens);
router.post('/tarefas/:id/itens', authenticate, ctrl.addItens);
router.patch('/tarefas/:id/itens/:itemId', authenticate, ctrl.marcarItem);
router.delete('/tarefas/:id/itens/:itemId', authenticate, ctrl.removerItem);

// ── Parceiros ─────────────────────────────────────────────────────────────────
router.get('/tarefas/:id/parceiros', authenticate, ctrl.parceiros);
router.post('/tarefas/:id/parceiros', authenticate, ctrl.convidar);
router.delete('/tarefas/:id/parceiros/:userId', authenticate, ctrl.removerParceiro);

// ── Convites (de QUALQUER módulo) ─────────────────────────────────────────────
// A pessoa responde a todos no mesmo lugar: um convite do Checklist e um do
// assistente são a mesma decisão para quem recebe.
router.get('/convites', authenticate, ctrl.convites);
router.post('/convites/:id/responder', authenticate, ctrl.responderConvite);
router.post('/convites/:id/cancelar', authenticate, ctrl.cancelarConvite);
router.get('/equipe', authenticate, ctrl.equipe);

router.get('/settings', authenticate, ctrl.settings);
router.put('/settings', authenticate, ctrl.salvarSettings);
router.post('/sincronizar', authenticate, ctrl.sincronizar);

export default router;

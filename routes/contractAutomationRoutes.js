// routes/contractAutomationRoutes.js
import express from 'express';
import ContractAutomationController from '../controllers/contractAutomationController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';

const router = express.Router();
const controller = new ContractAutomationController();

// Gatilhos manuais da análise automática de repasses. A execução recorrente é
// feita em processo pelo contractValidatorScheduler; estas rotas existem só
// para disparo/consulta manual e por isso exigem admin.

// Executar análise automática
router.post('/execute', authenticate, requireAdmin, async (req, res) => {
    await controller.executeAnalysis(req, res);
});

// Verificar status da análise
router.get('/status', authenticate, requireAdmin, async (req, res) => {
    await controller.getAnalysisStatus(req, res);
});

// Processar repasse específico
router.post('/process/:idRepasse', authenticate, requireAdmin, async (req, res) => {
    await controller.processSpecificRepasse(req, res);
});

// Listar repasses pendentes
router.get('/pending', authenticate, requireAdmin, async (req, res) => {
    await controller.listPendingRepasses(req, res);
});

// Configurar análise agendada
router.post('/schedule', authenticate, requireAdmin, async (req, res) => {
    await controller.configureScheduledAnalysis(req, res);
}); // ainda sem funcionamento

export default router;

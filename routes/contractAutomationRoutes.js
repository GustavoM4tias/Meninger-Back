// routes/contractAutomationRoutes.js
import express from 'express';
import ContractAutomationController from '../controllers/contractAutomationController.js';

const router = express.Router();
const controller = new ContractAutomationController();

// Executar análise automática
router.post('/execute', async (req, res) => {
    await controller.executeAnalysis(req, res);
});

// Verificar status da análise
router.get('/status', async (req, res) => {
    await controller.getAnalysisStatus(req, res);
});

// Processar repasse específico
router.post('/process/:idRepasse', async (req, res) => {
    await controller.processSpecificRepasse(req, res);
});

// Listar repasses pendentes
router.get('/pending', async (req, res) => {
    await controller.listPendingRepasses(req, res);
});

// Configurar análise agendada
router.post('/schedule', async (req, res) => {
    await controller.configureScheduledAnalysis(req, res);
}); // ainda sem funcionamento

export default router;
// routes/contractAutomationRoutes.js
import express from 'express';
import controller from '../controllers/contractAutomationController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';

const router = express.Router();

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

// Configurar análise agendada: a janela vive em CONTRACT_CRON_EXPRESSION /
// ENABLE_CONTRACT_SCHEDULE. A rota existia chamando um método comentado, ou
// seja, estourava TypeError em quem chamasse - melhor dizer o que é.
router.post('/schedule', authenticate, requireAdmin, (req, res) => {
    res.status(501).json({
        success: false,
        message: 'Agendamento não é configurável por aqui: use CONTRACT_CRON_EXPRESSION e ENABLE_CONTRACT_SCHEDULE.',
    });
});

export default router;

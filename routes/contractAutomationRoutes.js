// routes/contractAutomationRoutes.js
import express from 'express';
import controller from '../controllers/contractAutomationController.js';
import health from '../controllers/validatorHealthController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import requireCapability from '../middlewares/requireCapability.js';

const router = express.Router();

// Análise automática de contratos (repasses em "Analise Contratos").
//
// O gatilho é o webhook CONTRATOS_IA do CV: o repasse entra na etapa e o CV
// avisa na hora. Antes isto era um cron varrendo a base de tempos em tempos, o
// que atrasava o retorno e escondia a própria falha — quando o cron parava,
// nada mudava em lugar nenhum. As rotas autenticadas abaixo são o disparo
// manual e o diagnóstico.

// ── Webhook do CV (público: o CV não autentica) ──────────────────────────────
// O segredo vai na URL porque o painel do CV só oferece o campo "Endereço".
//
// Os dois parsers são de propósito: o server só monta express.json() global, e
// o CV posta formulário em alguns gatilhos. Sem o urlencoded aqui, o corpo
// chegaria vazio e a chamada viraria "corpo sem id" — falha calada, do tipo que
// o CV registra como entrega bem-sucedida.
router.post('/webhook/:token', express.json(), express.urlencoded({ extended: true }), async (req, res) => {
    await controller.receiveWebhook(req, res);
});

// Endereço para colar no painel do CV + prova de que ele está chamando
router.get('/webhook', authenticate, requireAdmin, async (req, res) => {
    await controller.getWebhookInfo(req, res);
});

// Varredura manual — a rede de segurança para o que o webhook perdeu
router.post('/execute', authenticate, requireAdmin, async (req, res) => {
    await controller.executeAnalysis(req, res);
});

// Estado: execução de agora, últimas execuções e quadro de parados
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

// ── Saúde do validador ───────────────────────────────────────────────────────
//
// A sonda (scheduler/validatorHealthScheduler.js) responde, sem depender de
// contrato nenhum, se DARIA para validar agora: os modelos do pool respondem, a
// API do validador está na URL certa, o gatilho do CV continua chamando.
//
// O farol é da tela (quem valida precisa saber que está fora do ar antes de
// subir o PDF). O detalhe e a configuração são de admin: ali moram o endereço
// secreto do webhook, os nomes de modelo e o que mexe na conta do provedor.
router.get('/health', authenticate, requireCapability('/validator', 'view'), health.getEstado);
router.get('/health/full', authenticate, requireCapability('/validator', 'configure'), health.getDetalhe);
router.post('/health/check', authenticate, requireCapability('/validator', 'configure'), health.rodarSonda);
router.put('/health/settings', authenticate, requireCapability('/validator', 'configure'), health.salvarConfig);

export default router;

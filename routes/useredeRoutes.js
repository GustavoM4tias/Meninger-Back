// routes/useredeRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireCapability from '../middlewares/requireCapability.js';
import {
    getSettings,
    updateSettings,
    testConnection,
    resetSession,
    excluirLinkHistorico,
    reenviarAoTitular,
    conferirPagamento,
} from '../controllers/userede/useredeController.js';

const router = express.Router();

// Uma linha por AÇÃO da tela; a regra de cada uma está em
// lib/screenCapabilities.js, a mesma que a tela consulta pelo useCan.
// Hoje a tela só tem configuração, então tudo é `configure` (admin). Quando o
// histórico de links entrar, ele nasce como `view`/`operate`, delegáveis por
// alçada, igual ao Boleto Caixa.
const TELA = '/financeiro/cobranca/ato';
const configurar = [authenticate, requireCapability(TELA, 'configure')];

router.get('/settings', ...configurar, getSettings);
router.patch('/settings', ...configurar, updateSettings);

// Dispara um login real contra o portal — por isso é admin e não leitura.
router.post('/test-connection', ...configurar, testConnection);
router.post('/session/reset', ...configurar, resetSession);

// Ações sobre um link do histórico: operação, não configuração - vão por alçada
// como as equivalentes do boleto.
const operar = [authenticate, requireCapability(TELA, 'operate')];
router.post('/history/:id/excluir', ...operar, excluirLinkHistorico);
router.post('/history/:id/resend', ...operar, reenviarAoTitular);
router.post('/history/:id/check-payment', ...operar, conferirPagamento);

export default router;

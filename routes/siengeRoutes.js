import express from 'express';
import multer from 'multer';
import { getContracts, listEnterprises, listCompanies, clearCache, getDistratos } from '../controllers/sienge/contractSalesController.js';
import authenticate from '../middlewares/authMiddleware.js';
import bulkDataController from '../controllers/sienge/bulkDataController.js';
import BillsController from '../controllers/sienge/billsController.js';
import {
    createLaunch, listLaunches, getLaunch, updateLaunch,
    advanceStage, cancelLaunch, markPaid,
    getSummary,
    runPipeline, findCreditor, findContract, createContract,
    validateItems, pollContract, createTituloController, registerBoletoController,
    pollNowController, updateBoletoController, abortPipelineController,
    downloadRidTemplate, sendRidEmail, sendRidForm, continueExistingContract
} from '../controllers/sienge/paymentFlowController.js';
import {
    listFlowEnterprises,
    resolveEnterprise,
} from '../controllers/sienge/enterpriseResolverController.js';
import {
    listLaunchTypes,
    createLaunchType,
    updateLaunchType,
} from '../controllers/sienge/launchTypeController.js';
import {
    listBackups,
    getBackup,
    triggerBackup,
    cancelBackup,
} from '../controllers/sienge/backupController.js';
import {
    getFilters as inadimplenciaFilters,
    getDashboard as inadimplenciaDashboard,
    getDetail as inadimplenciaDetail,
    exportCsv as inadimplenciaExport,
} from '../controllers/sienge/inadimplenciaController.js';


const router = express.Router();
const bulk = new bulkDataController();
const ctrl = new BillsController();

// upload em memória (não grava em disco)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// GET /api/contracts?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&situation=Emitido|Autorizado|Cancelado&enterpriseName=texto
router.get('/contracts', authenticate, getContracts);
router.get('/contracts/enterprises', authenticate, listEnterprises);
router.get('/contracts/companies', authenticate, listCompanies);
router.post('/contracts/cache/clear', authenticate, clearCache);

// Distratos (rescisões) — filtro por cancellation_date, inclui campos de cancelamento
router.get('/distratos', authenticate, getDistratos);

router.post('/contracts/sync/full', bulk.fullSync.bind(bulk));
router.post('/contracts/sync/delta', bulk.deltaSync.bind(bulk));
router.get('/contracts/sync/status', bulk.syncStatus.bind(bulk));

// Títulos (contas a pagar) — leitura AO VIVO do backup do Sienge
router.get('/bills', authenticate, ctrl.list);

// ── Inadimplência (admin-only) — lê do backup diário do Sienge (sie214801) ────
// Gate de admin é aplicado dentro do controller (req.user.role).
router.get('/inadimplencia/filters', authenticate, inadimplenciaFilters);
router.get('/inadimplencia/detail',  authenticate, inadimplenciaDetail);
router.get('/inadimplencia/export',  authenticate, inadimplenciaExport);
router.get('/inadimplencia',         authenticate, inadimplenciaDashboard);


// ── Guard: Fluxo de pagamento desabilitado neste ambiente ──────────────────────────
router.use('/payment-flow', (req, res, next) => {
    if (process.env.PAYMENT_FLOW_ENABLED !== 'true') {
        return res.status(503).json({ error: 'Fluxo de pagamento desabilitado neste ambiente (PAYMENT_FLOW_ENABLED=false).' });
    }
    next();
});
router.use('/launch-types', (req, res, next) => {
    if (process.env.PAYMENT_FLOW_ENABLED !== 'true') {
        return res.status(503).json({ error: 'Fluxo de pagamento desabilitado neste ambiente (PAYMENT_FLOW_ENABLED=false).' });
    }
    next();
});

// ── Tipos de Lançamento (dinâmicos, tabela launch_type_configs) ───────────────
router.get('/launch-types', authenticate, listLaunchTypes);
router.post('/launch-types', authenticate, createLaunchType);
router.patch('/launch-types/:id', authenticate, updateLaunchType);

// ── Backup do banco Sienge (cron + log + pg_restore no Postgres Railway) ──────
router.get('/backups', authenticate, listBackups);
router.get('/backups/:id', authenticate, getBackup);
router.post('/backups/trigger', authenticate, triggerBackup);
router.post('/backups/:id/cancel', authenticate, cancelBackup);

// ── Empreendimentos (enterprise_cities) ───────────────────────────────────────
router.get('/payment-flow/enterprises', authenticate, listFlowEnterprises);   // ?q=termo
router.get('/payment-flow/enterprises/resolve', authenticate, resolveEnterprise); // ?name=MARILIA/SP...

// ── CRUD lançamentos ──────────────────────────────────────────────────────────
router.get('/payment-flow/', authenticate, listLaunches);
router.get('/payment-flow/summary', authenticate, getSummary);
router.get('/payment-flow/:id', authenticate, getLaunch);
router.post('/payment-flow/', authenticate, createLaunch);
router.patch('/payment-flow/:id', authenticate, updateLaunch);

// ── Pipeline Sienge ───────────────────────────────────────────────────────────
router.post('/payment-flow/:id/pipeline/run', authenticate, runPipeline);
router.post('/payment-flow/:id/pipeline/find-creditor', authenticate, findCreditor);
router.post('/payment-flow/:id/pipeline/find-contract', authenticate, findContract);
router.post('/payment-flow/:id/pipeline/create-contract', authenticate, createContract);
router.post('/payment-flow/:id/pipeline/validate-items', authenticate, validateItems);
router.get('/payment-flow/:id/pipeline/poll-contract', authenticate, pollContract);
router.post('/payment-flow/:id/pipeline/create-titulo', authenticate, createTituloController);
router.post('/payment-flow/:id/pipeline/register-boleto', authenticate, registerBoletoController);
router.get('/payment-flow/:id/pipeline/poll-now', authenticate, pollNowController);
router.post('/payment-flow/:id/pipeline/update-boleto', authenticate, updateBoletoController);
router.post('/payment-flow/:id/pipeline/abort', authenticate, abortPipelineController);

// ── RID (cadastro de fornecedor) ──────────────────────────────────────────────
router.get('/payment-flow/rid-template', authenticate, downloadRidTemplate);
router.post('/payment-flow/:id/rid/send-email', authenticate, upload.single('rid'), sendRidEmail);   // legado (upload manual)
router.post('/payment-flow/:id/rid/send-form', authenticate, upload.fields([{ name: 'anexos', maxCount: 10 }]), sendRidForm); // novo (formulário → gera docx + anexos opcionais)

// ── Transitions ───────────────────────────────────────────────────────────────
router.post('/payment-flow/:id/advance-stage', authenticate, advanceStage);
router.post('/payment-flow/:id/cancel', authenticate, cancelLaunch);
router.post('/payment-flow/:id/mark-paid', authenticate, markPaid);

router.post('/payment-flow/:id/continue-existing-contract', authenticate, continueExistingContract);


export default router;

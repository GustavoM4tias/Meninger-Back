import express from 'express';
import multer from 'multer';
import { getContracts, listEnterprises, clearCache, getDistratos } from '../controllers/sienge/contractSalesController.js';
import authenticate from '../middlewares/authMiddleware.js';
import bulkDataController from '../controllers/sienge/bulkDataController.js';
import BillsController from '../controllers/sienge/billsController.js';
import { uploadNfseAward, getAwards, updateAward, registerSales, attachNfseToAward, bulkAttachNfse, clearNfseFromAwards, deleteAward, deleteAwards } from "../controllers/sienge/awardController.js";
import {
    createLaunch, listLaunches, getLaunch, updateLaunch,
    advanceStage, cancelLaunch, markPaid,
    getSummary,
    runPipeline, findCreditor, findContract, createContract,
    validateItems, pollContract,
    downloadRidTemplate, sendRidEmail, sendRidForm,
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
router.post('/contracts/cache/clear', authenticate, clearCache);

// Distratos (rescisões) — filtro por cancellation_date, inclui campos de cancelamento
router.get('/distratos', authenticate, getDistratos);

router.post('/contracts/sync/full', bulk.fullSync.bind(bulk));
router.post('/contracts/sync/delta', bulk.deltaSync.bind(bulk));
router.get('/contracts/sync/status', bulk.syncStatus.bind(bulk));

router.post('/bills/sync', authenticate, ctrl.sync);
router.get('/bills', authenticate, ctrl.list);

// Sync completo de empreendimento (fire-and-forget + polling)
router.post('/bills/sync-enterprise', authenticate, ctrl.startEnterpriseSync);
router.get('/bills/sync-enterprise/status/:costCenterId', authenticate, ctrl.getEnterpriseSyncStatus);

router.post("/awards/nfse", authenticate, upload.single("file"), uploadNfseAward);
router.post("/awards/nfse/bulk", authenticate, upload.single("file"), bulkAttachNfse);
router.post("/awards/nfse/clear", authenticate, clearNfseFromAwards);
router.post("/awards/:id/attach-nfse", authenticate, upload.single("file"), attachNfseToAward);
router.get("/awards", authenticate, getAwards);
router.put("/awards/:id", authenticate, updateAward);
router.delete("/awards/:id", authenticate, deleteAward);
router.post("/awards/delete", authenticate, deleteAwards);
router.post("/awards/register-sales", authenticate, registerSales);

// ── Tipos de Lançamento (dinâmicos, tabela launch_type_configs) ───────────────
router.get('/launch-types', authenticate, listLaunchTypes);
router.post('/launch-types', authenticate, createLaunchType);
router.patch('/launch-types/:id', authenticate, updateLaunchType);

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

// ── RID (cadastro de fornecedor) ──────────────────────────────────────────────
router.get('/payment-flow/rid-template', authenticate, downloadRidTemplate);
router.post('/payment-flow/:id/rid/send-email', authenticate, upload.single('rid'), sendRidEmail);   // legado (upload manual)
router.post('/payment-flow/:id/rid/send-form', authenticate, upload.fields([{ name: 'anexos', maxCount: 10 }]), sendRidForm); // novo (formulário → gera docx + anexos opcionais)

// ── Transitions ───────────────────────────────────────────────────────────────
router.post('/payment-flow/:id/advance-stage', authenticate, advanceStage);
router.post('/payment-flow/:id/cancel', authenticate, cancelLaunch);
router.post('/payment-flow/:id/mark-paid', authenticate, markPaid);

export default router;

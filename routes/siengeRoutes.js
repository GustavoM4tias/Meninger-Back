import express from 'express';
import multer from 'multer';
import { getContracts, listEnterprises, clearCache } from '../controllers/sienge/contractSalesController.js';
import authenticate from '../middlewares/authMiddleware.js';
import bulkDataController from '../controllers/sienge/bulkDataController.js';
import BillsController from '../controllers/sienge/billsController.js';
import { uploadNfseAward, getAwards, updateAward, registerSales, attachNfseToAward, bulkAttachNfse, clearNfseFromAwards, deleteAward, deleteAwards } from "../controllers/sienge/awardController.js";

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

router.post('/contracts/sync/full', bulk.fullSync.bind(bulk));
router.post('/contracts/sync/delta', bulk.deltaSync.bind(bulk));

router.post('/bills/sync', authenticate, ctrl.sync);
router.get('/bills', authenticate, ctrl.list);

router.post("/awards/nfse", authenticate, upload.single("file"), uploadNfseAward);
router.post("/awards/nfse/bulk", authenticate, upload.single("file"), bulkAttachNfse);
router.post("/awards/nfse/clear", authenticate, clearNfseFromAwards);
router.post("/awards/:id/attach-nfse", authenticate, upload.single("file"), attachNfseToAward);
router.get("/awards", authenticate, getAwards);
router.put("/awards/:id", authenticate, updateAward);
router.delete("/awards/:id", authenticate, deleteAward);
router.post("/awards/delete", authenticate, deleteAwards);
router.post("/awards/register-sales", authenticate, registerSales);

export default router;

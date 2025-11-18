import express from 'express'; 
import { getContracts, listEnterprises, clearCache } from '../controllers/sienge/contractSalesController.js';
import authenticate from '../middlewares/authMiddleware.js'; 
import bulkDataController from '../controllers/sienge/bulkDataController.js';
import BillsController from '../controllers/sienge/billsController.js';

const router = express.Router();
const bulk = new bulkDataController();
const ctrl = new BillsController();

// GET /api/contracts?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&situation=Emitido|Autorizado|Cancelado&enterpriseName=texto
router.get('/contracts', authenticate, getContracts);
router.get('/contracts/enterprises', authenticate, listEnterprises);
router.post('/contracts/cache/clear', authenticate, clearCache);

router.post('/contracts/sync/full',  bulk.fullSync.bind(bulk));
router.post('/contracts/sync/delta', bulk.deltaSync.bind(bulk));

router.post('/bills/sync', ctrl.sync);
router.get('/bills',       ctrl.list);

export default router;
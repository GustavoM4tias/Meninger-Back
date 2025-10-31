import express from 'express'; 
import { getContracts, listEnterprises, clearCache } from '../controllers/sienge/contractSalesController.js';
import authenticate from '../middlewares/authMiddleware.js'; 
import bulkDataController from '../controllers/sienge/bulkDataController.js';

const router = express.Router();
const bulk = new bulkDataController();

// GET /api/contracts?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&situation=Emitido|Autorizado|Cancelado&enterpriseName=texto
router.get('/contracts', authenticate, getContracts);
router.get('/contracts/enterprises', authenticate, listEnterprises);
router.post('/contracts/cache/clear', authenticate, clearCache);

router.post('/contracts/sync/full',  bulk.fullSync.bind(bulk));
router.post('/contracts/sync/delta', bulk.deltaSync.bind(bulk));

export default router;
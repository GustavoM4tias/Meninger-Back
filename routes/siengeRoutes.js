import express from 'express';
 
import { fetchContratos, clearContratosCache } from '../controllers/sienge/contratos.js' 
import SiengeController from '../controllers/sienge/siengeController.js';

const router = express.Router();
const ctl = new SiengeController();
 
router.get('/contratos', fetchContratos);

router.post('/contratos/cache/clear', clearContratosCache);

router.post('/sync/full',  ctl.fullSync.bind(ctl));
router.post('/sync/delta', ctl.deltaSync.bind(ctl));

export default router;
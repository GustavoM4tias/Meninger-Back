import express from 'express';
 
import { fetchContratos, clearContratosCache } from '../controllers/sienge/contratos.js' 
const router = express.Router();
 
router.get('/contratos', fetchContratos);

router.post('/contratos/cache/clear', clearContratosCache);

export default router;
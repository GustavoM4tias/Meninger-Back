import express from 'express';
 
import { fetchContratos } from '../controllers/sienge/contratos.js' 
const router = express.Router();
 
router.get('/contratos', fetchContratos);

export default router;
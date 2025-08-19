import express from 'express';
import authenticate from '../middlewares/authMiddleware.js'; 

import { fetchRepasses, fetchRepasseWorkflow } from '../controllers/cv/repasses.js'
import { fetchReservas, fetchReservaPagamentos } from '../controllers/cv/reservas.js'
import { fetchEmpreendimentos, fetchBuildings, fetchBuildingById } from '../controllers/cv/empreendimentos.js'
import { fetchFilas, getLeads } from '../controllers/cv/leads.js'
import { fetchBanners } from '../controllers/cv/banner.js'
import bulkDataController from '../controllers/cv/bulkDataController.js';
 
const router = express.Router();
const bulk = new bulkDataController();
 
router.get('/repasses', authenticate, fetchRepasses);
router.get('/repasse-workflow', authenticate, fetchRepasseWorkflow); 
router.get('/reservas', authenticate, fetchReservas);
router.get('/reserva-pagamentos', authenticate, fetchReservaPagamentos);
router.get('/listagem-empreendimentos', authenticate, fetchEmpreendimentos); 
router.get('/empreendimentos', authenticate, fetchBuildings);
router.get('/empreendimento/:id', authenticate, fetchBuildingById);
router.get('/filas', authenticate, fetchFilas);
router.get('/banners', authenticate, fetchBanners);

router.post('/leads/sync/full', authenticate, bulk.fullSync.bind(bulk));
router.post('/leads/sync/delta', authenticate, bulk.deltaSync.bind(bulk));

router.get('/leads', authenticate, getLeads); 


export default router;
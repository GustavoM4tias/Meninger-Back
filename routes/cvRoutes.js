import express from 'express';

import { fetchRepasses, fetchRepasseWorkflow } from '../controllers/cv/repasses.js'
import { fetchReservas, fetchReservaPagamentos } from '../controllers/cv/reservas.js'
import { fetchEmpreendimentos, fetchBuildings, fetchBuildingById } from '../controllers/cv/empreendimentos.js'
import { fetchFilas, fetchLeads } from '../controllers/cv/leads.js'
import { fetchBanners } from '../controllers/cv/banner.js'
import bulkDataController from '../controllers/cv/bulkDataController.js';
 
const router = express.Router();
const bulk = new bulkDataController();
 
router.get('/repasses', fetchRepasses);
router.get('/repasse-workflow', fetchRepasseWorkflow); 
router.get('/reservas', fetchReservas);
router.get('/reserva-pagamentos', fetchReservaPagamentos);
router.get('/listagem-empreendimentos', fetchEmpreendimentos); 
router.get('/empreendimentos', fetchBuildings);
router.get('/empreendimento/:id', fetchBuildingById);
router.get('/filas', fetchFilas);
router.get('/leads', fetchLeads); 
router.get('/banners', fetchBanners);

router.post('/leads/sync/full',   bulk.fullSync.bind(bulk));
router.post('/leads/sync/delta',  bulk.deltaSync.bind(bulk));

export default router;
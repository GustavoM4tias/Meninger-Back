import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';

import { fetchRepasses, fetchRepasseWorkflow } from '../controllers/cv/repasses.js'
import { fetchReservas, fetchReservaPagamentos, fetchReservaWorkflow } from '../controllers/cv/reservas.js'
import { fetchEmpreendimentos, fetchBuildings, fetchBuildingById } from '../controllers/cv/empreendimentos.js'
import { fetchFilas, getLeads } from '../controllers/cv/leads.js'
import { fetchBanners } from '../controllers/cv/banner.js'

import bulkDataController from '../services/bulkData/cv/bulkDataController.js';
import RepassesSyncController from '../controllers/cv/repassesSyncController.js';
import ReservasSyncController from '../controllers/cv/reservasSyncController.js';

import { fetchBuildingsFromDb, fetchBuildingByIdFromDb } from '../controllers/cv/empreendimentosDb.js';
import EnterprisesSyncController from '../controllers/cv/enterprisesSyncController.js';

import { fetchWorkflowGroups, createOrUpdateWorkflowGroup, removeWorkflowGroup } from '../controllers/cv/workflowGroups.js';

const router = express.Router();
const cvLeads = new bulkDataController();
const cvRepasses = new RepassesSyncController();
const cvReservas = new ReservasSyncController();
const cvEnterprises = new EnterprisesSyncController();

router.get('/repasses', authenticate, fetchRepasses);
router.get('/repasse-workflow', authenticate, fetchRepasseWorkflow);


router.get('/reservas', authenticate, fetchReservas);
// ⬇️ NOVO: workflow de reservas + grupos paralelos
router.get('/reserva-workflow', authenticate, fetchReservaWorkflow)
router.get('/reserva-pagamentos', authenticate, fetchReservaPagamentos);

router.get('/listagem-empreendimentos', authenticate, fetchEmpreendimentos);
// router.get('/empreendimentos', authenticate, fetchBuildings);
// router.get('/empreendimento/:id', authenticate, fetchBuildingById);
router.get('/filas', authenticate, fetchFilas);
router.get('/banners', fetchBanners);

router.post('/leads/sync/full', authenticate, cvLeads.fullSync.bind(cvLeads));
router.post('/leads/sync/delta', authenticate, cvLeads.deltaSync.bind(cvLeads));

router.get('/leads', authenticate, getLeads);

// NOVO: Repasses (backup + histórico)
router.post('/repasses/sync/full', authenticate, cvRepasses.fullSync.bind(cvRepasses));
router.post('/repasses/sync/delta', authenticate, cvRepasses.deltaSync.bind(cvRepasses));

// NOVO: Reservas (backup + histórico por status de repasse)
router.post('/reservas/sync/full', authenticate, cvReservas.fullSync.bind(cvReservas));
router.post('/reservas/sync/delta', authenticate, cvReservas.deltaSync.bind(cvReservas));

router.post('/empreendimentos/sync/full', authenticate, cvEnterprises.fullSync.bind(cvEnterprises));
router.post('/empreendimentos/sync/delta', authenticate, cvEnterprises.deltaSync.bind(cvEnterprises));

router.get('/empreendimentos', authenticate, fetchBuildingsFromDb);
router.get('/empreendimento/:id', authenticate, fetchBuildingByIdFromDb);

router.get('/workflow-grupos', authenticate, fetchWorkflowGroups);
router.post('/workflow-grupos', authenticate, createOrUpdateWorkflowGroup);
router.delete('/workflow-grupos/:id', authenticate, removeWorkflowGroup);

export default router;
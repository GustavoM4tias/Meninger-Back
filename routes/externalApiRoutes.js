import express from 'express';
import {
    fetchRepasses,
    fetchReservations,
    fetchBanners,
    fetchBuildings,
    fetchBuildingById,
    fetchFilas,
    fetchLeads,
    fetchEmpreendimentos,
    fetchRepasseWorkflow
} from '../controllers/externalApiController.js';

const router = express.Router();

// Endpoint para buscar repasses
router.get('/repasses', fetchRepasses);

// Endpoint para buscar apenas empreendimentos
router.get('/listagem-empreendimentos', fetchEmpreendimentos);

// Endpoint para buscar reservas
router.get('/reservas', fetchReservations);

// New route for banners
router.get('/banners', fetchBanners);

// New route for buildings
router.get('/empreendimentos', fetchBuildings);

router.get('/empreendimento/:id', fetchBuildingById);

router.get('/filas', fetchFilas);

router.get('/leads', fetchLeads);

// Nova rota para workflow de repasses
router.get('/repasse-workflow', fetchRepasseWorkflow);


export default router;
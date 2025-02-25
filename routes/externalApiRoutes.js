import express from 'express';
import { fetchReservations, fetchDistracts, fetchBuildings, fetchBuildingById, fetchFilas, fetchLeads } from '../controllers/externalApiController.js';

const router = express.Router();

// Endpoint para buscar reservas
router.get('/reservas', fetchReservations);

// New route for distracts
router.get('/distratos', fetchDistracts);

// New route for buildings
router.get('/empreendimentos', fetchBuildings);

router.get('/empreendimento/:id', fetchBuildingById);

router.get('/filas', fetchFilas);

router.get('/leads', fetchLeads);

export default router;


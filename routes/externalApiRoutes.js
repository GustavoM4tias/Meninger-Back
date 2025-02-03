import express from 'express';
import { fetchReservations, fetchDistracts, fetchBuildings, fetchBuildingById } from '../controllers/externalApiController.js';

const router = express.Router();

// Endpoint para buscar reservas
router.get('/reservas', fetchReservations);

// New route for distracts
router.get('/distratos', fetchDistracts);

// New route for buildings
router.get('/empreendimentos', fetchBuildings);

router.get('/empreendimento/:id', fetchBuildingById);

export default router;


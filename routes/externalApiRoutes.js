import express from 'express';
import { fetchReservations, fetchDistracts } from '../controllers/externalApiController.js';

const router = express.Router();

// Endpoint para buscar reservas
router.get('/reservas', fetchReservations);

// New route for distracts
router.get('/distratos', fetchDistracts);

export default router;


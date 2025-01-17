import express from 'express';
import { fetchReservations } from '../controllers/externalApiController.js';

const router = express.Router();

// Endpoint para buscar reservas
router.get('/reservas', fetchReservations);

export default router;

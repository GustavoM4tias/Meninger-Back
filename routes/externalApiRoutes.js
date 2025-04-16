import express from 'express';
import {
    fetchRepasses, 
    fetchBanners,
    fetchBuildings,
    fetchBuildingById,
    fetchFilas,
    fetchLeads,
    fetchEmpreendimentos,
    fetchRepasseWorkflow,
    fetchReservaPagamentos,
    fetchReservas  // Nova importação
} from '../controllers/externalApiController.js';

const router = express.Router();

// Rotas existentes...
router.get('/repasses', fetchRepasses);
router.get('/listagem-empreendimentos', fetchEmpreendimentos); 
router.get('/banners', fetchBanners);
router.get('/empreendimentos', fetchBuildings);
router.get('/empreendimento/:id', fetchBuildingById);
router.get('/filas', fetchFilas);
router.get('/leads', fetchLeads);
router.get('/repasse-workflow', fetchRepasseWorkflow); 
router.get('/reserva-pagamentos', fetchReservaPagamentos);

// Nova rota para as reservas da API CVIO
router.get('/reservas', fetchReservas);

export default router;
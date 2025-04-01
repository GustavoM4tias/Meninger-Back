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
    fetchRepasseWorkflow,
    fetchReservaPagamentos  // Nova importação
} from '../controllers/externalApiController.js';

const router = express.Router();

// Rotas existentes...
router.get('/repasses', fetchRepasses);
router.get('/listagem-empreendimentos', fetchEmpreendimentos);
router.get('/reservas', fetchReservations);
router.get('/banners', fetchBanners);
router.get('/empreendimentos', fetchBuildings);
router.get('/empreendimento/:id', fetchBuildingById);
router.get('/filas', fetchFilas);
router.get('/leads', fetchLeads);
router.get('/repasse-workflow', fetchRepasseWorkflow);

// Nova rota para condições de pagamento da reserva
router.get('/reserva-pagamentos', fetchReservaPagamentos);

export default router;
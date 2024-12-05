// api/routes/buildingRoutes.js
import express from 'express';
import { addBuilding, getBuildings, updateBuilding, deleteBuilding } from '../controllers/buildingController.js';
import authenticate from '../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/add', authenticate, addBuilding);
router.get('/', getBuildings);    
router.put('/edit/:id', updateBuilding); // Nova rota para edição de empreendimento               
router.delete('/delete/:id', authenticate, deleteBuilding); // Nova rota para exclusão de empreendimento

export default router;

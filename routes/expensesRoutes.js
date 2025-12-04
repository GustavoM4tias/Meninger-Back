// routes/expenses.js
import { Router } from 'express';
import expenseController from '../controllers/expenseController.js';
import authenticate from '../middlewares/authMiddleware.js';

const router = Router();
const ctrl = new expenseController();

router.use(authenticate);

router.post('', authenticate, ctrl.add);
router.get('',  ctrl.listMonth);
router.put('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);
router.get('/links', ctrl.listLinks);

export default router;

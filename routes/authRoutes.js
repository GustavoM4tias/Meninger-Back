// api/routes/authRoutes.js
import express from 'express';
import { registerUser, loginUser, getUserInfo } from '../controllers/authController.js';
import authenticate from '../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/register', registerUser);
router.post('/login', loginUser);
// Rota para obter informações do usuário
router.get('/user', authenticate, getUserInfo);

export default router;

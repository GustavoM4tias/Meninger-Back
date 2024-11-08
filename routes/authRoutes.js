// api/routes/authRoutes.js
import express from 'express';
import { registerUser, loginUser, getUserInfo, updateUser } from '../controllers/authController.js';
import authenticate from '../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/register', registerUser);
router.post('/login', loginUser);
router.get('/user', authenticate, getUserInfo);
router.put('/user', authenticate, updateUser); // Nova rota para atualização

export default router;

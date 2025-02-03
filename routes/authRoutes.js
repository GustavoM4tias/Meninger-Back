// api/routes/authRoutes.js
import express from 'express';
import { registerUser, loginUser, getUserInfo, updateMe, updateUser, getAllUsers, getUserById } from '../controllers/authController.js';
import authenticate from '../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/register', registerUser);
router.post('/login', loginUser);
router.get('/user', authenticate, getUserInfo);
router.get('/user/:id', authenticate, getUserById);  // Rota para obter usuario pelo ID
router.put('/user', authenticate, updateMe); // Nova rota para atualização
router.get('/users', authenticate, getAllUsers);  // Rota para obter todos os usuários
router.put('/users', authenticate, updateUser);  // Rota para obter todos os usuários


export default router;

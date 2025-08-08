// api/routes/authRoutes.js
import express from 'express';
import { registerUser, loginUser, getUserInfo, updateMe, updateUser, getAllUsers, getUserById } from '../controllers/authController.js';
import authenticate from '../middlewares/authMiddleware.js';
import { authorizeStrict, authorizeByRole, authorizeByPosition, filterByCity } from '../middlewares/permissionMiddleware.js';

const router = express.Router();

router.post( '/register', authenticate, authorizeByRole(['admin', 'manager']), registerUser );
router.post('/login', loginUser);
router.get('/user', authenticate, getUserInfo);
router.put('/user', authenticate, updateMe); // Nova rota para atualização
router.get('/user/:id', authenticate, authorizeByRole(['admin', 'manager']), getUserById);  // Rota para obter usuario pelo ID
// router.get('/users', authenticate, authorizeByRole(['admin', 'manager']), getAllUsers);  // Rota para obter todos os usuários
router.get('/users', authenticate, getAllUsers);  // Rota para obter todos os usuários
router.put('/users', authenticate, authorizeByRole(['admin', 'manager']), updateUser); 

export default router;

// ATUALIZAR RETORNOS MICROSOFT NAS ROTAS


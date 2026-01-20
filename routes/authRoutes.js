// api/routes/authRoutes.js
import express from 'express';
import { registerUser, loginUser, enrollFace, identifyFace, getUserInfo, updateMe, updateUser, getAllUsers, getUserById } from '../controllers/authController.js';
import authenticate from '../middlewares/authMiddleware.js';
import { authorizeStrict, authorizeByRole, authorizeByPosition, filterByCity } from '../middlewares/permissionMiddleware.js';

const router = express.Router();

router.post( '/register', authenticate, authorizeByRole(['admin']), registerUser );
router.post('/login', loginUser);
router.get('/user', authenticate, getUserInfo);
router.put('/user', authenticate, updateMe); // Nova rota para atualização
router.get('/user/:id', authenticate, authorizeByRole(['admin']), getUserById);  // Rota para obter usuario pelo ID
// router.get('/users', authenticate, authorizeByRole(['admin']), getAllUsers);  // Rota para obter todos os usuários
router.get('/users', authenticate, getAllUsers);  // Rota para obter todos os usuários
router.put('/users', authenticate, authorizeByRole(['admin']), updateUser); 
router.post('/face/enroll', authenticate, enrollFace);     // cria/atualiza template
router.post('/face/identify', identifyFace);           // NOVO (sem email)

export default router;

// /routes/permissionRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import { getMyPermissions, getAllPermissions, setUserPermissions } from '../controllers/permissionController.js';

const router = express.Router();

const adminOnly = (req, res, next) => {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ message: 'Acesso restrito a administradores.' });
    }
    next();
};

// Rota para qualquer usuário autenticado — retorna as próprias permissões
router.get('/me', authenticate, getMyPermissions);

// Rotas de administração
router.get('/', authenticate, adminOnly, getAllPermissions);
router.put('/:userId', authenticate, adminOnly, setUserPermissions);

export default router;

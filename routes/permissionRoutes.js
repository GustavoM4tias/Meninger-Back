// /routes/permissionRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import { getMyPermissions, getAllPermissions, setUserPermissions } from '../controllers/permissionController.js';
import { getProfiles, createProfile, updateProfile, deleteProfile } from '../controllers/permissionProfileController.js';

const router = express.Router();

const adminOnly = (req, res, next) => {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ message: 'Acesso restrito a administradores.' });
    }
    next();
};

// Rota do usuário autenticado
router.get('/me', authenticate, getMyPermissions);

// Perfis de alçadas (específico antes do paramétrico /:userId)
router.get('/profiles', authenticate, adminOnly, getProfiles);
router.post('/profiles', authenticate, adminOnly, createProfile);
router.put('/profiles/:id', authenticate, adminOnly, updateProfile);
router.delete('/profiles/:id', authenticate, adminOnly, deleteProfile);

// Usuários (admin only)
router.get('/', authenticate, adminOnly, getAllPermissions);
router.put('/:userId', authenticate, adminOnly, setUserPermissions);

export default router;

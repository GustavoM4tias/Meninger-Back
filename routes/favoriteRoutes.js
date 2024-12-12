// api/routes/favoriteRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import { addFavorite, removeFavorite, getFavorites } from '../controllers/favoriteController.js';

const router = express.Router();

// Adicionar favorito
router.post('/', authenticate, addFavorite);

// Remover favorito - Alterando a rota para passar router e section como parâmetros
router.delete('/:router/:section', authenticate, removeFavorite);

// Obter favoritos do usuário
router.get('/', authenticate, getFavorites);

export default router;

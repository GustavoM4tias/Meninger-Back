// api/routes/favoriteRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import { addFavorite, removeFavorite, getFavorites } from '../controllers/favoriteController.js';

const router = express.Router();

router.post('/', authenticate, addFavorite); // Adicionar favorito
router.delete('/:router/:section', authenticate, removeFavorite); // Remover favorito - Alterando a rota para passar router e section como parâmetros
router.get('/', authenticate, getFavorites);// Obter favoritos do usuário

export default router;

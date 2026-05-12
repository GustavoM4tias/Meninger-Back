// api/routes/favoriteRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import { addFavorite, removeFavorite, getFavorites } from '../controllers/favoriteController.js';

const router = express.Router();

router.post('/', authenticate, addFavorite);
router.delete('/:router/:section', authenticate, removeFavorite);
router.get('/', authenticate, getFavorites);

export default router;

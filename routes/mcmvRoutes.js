// routes/mcmvRoutes.js
import express from 'express';
import multer from 'multer';
import authenticate from '../middlewares/authMiddleware.js';
import requireRoutePermission from '../middlewares/requireRoutePermission.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import { searchMunicipios, getInfo, importXlsx, queryForAI } from '../controllers/comercial/mcmvController.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(authenticate);

// Alçada da tela MCMV (admin bypassa no middleware).
const requireMcmv = requireRoutePermission(['/comercial/mcmv']);

router.get('/search',   requireMcmv, searchMunicipios);
router.get('/info',     requireMcmv, getInfo);
router.get('/ai-query', queryForAI);       // usado pela IA (function calling) — sem alçada de tela
router.post('/import',  requireAdmin, upload.single('file'), importXlsx);   // tela /comercial/mcmv/settings é admin

export default router;

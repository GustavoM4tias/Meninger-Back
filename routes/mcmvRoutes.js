// routes/mcmvRoutes.js
import express from 'express';
import multer from 'multer';
import authenticate from '../middlewares/authMiddleware.js';
import { searchMunicipios, getInfo, importXlsx, queryForAI } from '../controllers/comercial/mcmvController.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(authenticate);

router.get('/search',   searchMunicipios);
router.get('/info',     getInfo);
router.get('/ai-query', queryForAI);       // usado pela IA (function calling)
router.post('/import',  upload.single('file'), importXlsx);

export default router;

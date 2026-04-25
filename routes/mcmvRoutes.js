// routes/mcmvRoutes.js
import express from 'express';
import multer from 'multer';
import authenticate from '../middlewares/authMiddleware.js';
import { searchMunicipios, getInfo, importXlsx } from '../controllers/comercial/mcmvController.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(authenticate);

router.get('/search', searchMunicipios);
router.get('/info',   getInfo);
router.post('/import', upload.single('file'), importXlsx);

export default router;

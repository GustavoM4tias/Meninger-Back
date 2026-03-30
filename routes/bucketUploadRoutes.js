// /routes/bucketUploadRoutes.js
import express from 'express';
import multer from 'multer';
import authenticate from '../middlewares/authMiddleware.js';
import { previewUpload, confirmUpload, getHistory } from '../controllers/bucketUploadController.js';

const router = express.Router();

const xlsxUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
    fileFilter: (_req, file, cb) => {
        const allowed = [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel',
        ];
        if (!allowed.includes(file.mimetype)) {
            return cb(new Error('Apenas arquivos .xlsx são aceitos.'));
        }
        cb(null, true);
    },
});

router.post('/preview', authenticate, xlsxUpload.single('file'), previewUpload);
router.post('/confirm', authenticate, confirmUpload);
router.get('/history', authenticate, getHistory);

export default router;

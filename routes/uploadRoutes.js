import express from 'express';
import upload from '../middlewares/uploadMiddleware.js';
import { uploadFile } from '../controllers/uploadController.js';
import authenticate from '../middlewares/authMiddleware.js';

const router = express.Router();

// Contextos que não exigem autenticação (ex: uploads públicos em fluxos externos)
const PUBLIC_CONTEXTS = ['event_image'];

// Middleware condicional: autentica sempre que possível; bloqueia apenas
// se o contexto exige userId e o token não foi enviado.
async function optionalAuthenticate(req, res, next) {
    const token = req.header('Authorization')?.split(' ')[1];
    if (token) {
        // Há token — autentica normalmente
        return authenticate(req, res, next);
    }
    // Sem token — prossegue (o buildUploadConfig lançará erro se o contexto exigir userId)
    next();
}

// Multer com tratamento de erro limpo: estouro do limite de tamanho (10 MB) ou tipo
// inválido retorna 400 legível em vez de estourar 500 — aparece no card do AttachmentPicker.
function handleUpload(req, res, next) {
    upload.single('file')(req, res, (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE'
                ? 'Arquivo muito grande. O limite é 10 MB.'
                : (err.message || 'Falha no upload do arquivo.');
            return res.status(400).json({ message: msg });
        }
        next();
    });
}

router.post(
    '/',
    optionalAuthenticate,
    handleUpload,
    uploadFile
);

export default router;
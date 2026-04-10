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

router.post(
    '/',
    optionalAuthenticate,
    upload.single('file'),
    uploadFile
);

export default router;
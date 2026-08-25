// validatorAI/index.js
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import helmet from 'helmet';
import authenticate from '../middlewares/authMiddleware.js';
import requireRoutePermission from '../middlewares/requireRoutePermission.js';
import { hasValidInternalJobToken } from '../security/internalJobToken.js';
import { documentRoutes } from './src/routes/documentRoutes.js';
import { chatRoutes } from './src/routes/chatRoutes.js';
import statsRoutes from './src/routes/statsRoutes.js';
import { errorHandler } from './src/middleware/errorHandler.js';
import historyRoutes from './src/routes/historyRoutes.js';
import { paymentFlowRoutes } from './src/routes/paymentFlowRoutes.js';

const app = express();

// Configuração do multer para upload de arquivos
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype !== 'application/pdf') {
            return cb(new Error('Apenas arquivos PDF são permitidos.'));
        }
        cb(null, true);
    },
});

app.use(cors());
app.use(helmet());
app.use(express.json());

// 🔒 SEGURANÇA: /chat, /token, /payment-flow e /validator/history exigem authenticate.
// Alçada da tela do Validador (admin bypassa no middleware).
// ORDEM IMPORTA: /validator/history ANTES do prefixo /validator, senão o
// gate de /validator barraria o histórico da tela.
const requireValidator = requireRoutePermission(['/validator']);
app.use('/validator/history', authenticate, requireValidator, historyRoutes);
// /validator tem DOIS chamadores legítimos e nenhum deles pode barrar o outro:
//   1. o job de análise automática de contratos, server-to-server, sem usuário
//      no fluxo - entra pelo token interno (security/internalJobToken);
//   2. a tela do Validador, onde alguém sobe os dois PDFs na mão - entra pelo
//      JWT do usuário, com a alçada da rota.
// Exigir só o token interno derrubava a tela com 401 'Token interno inválido'
// (o navegador nunca teve como mandar esse header) e o botão Validar ficou mudo
// desde 29/07.
const internoOuUsuario = (req, res, next) => {
    if (hasValidInternalJobToken(req)) return next();
    return authenticate(req, res, (err) => (
        err ? next(err) : requireValidator(req, res, next)
    ));
};
app.use('/validator', internoOuUsuario, documentRoutes(upload));
app.use('/chat', authenticate, requireValidator, chatRoutes);
app.use('/token', authenticate, requireValidator, statsRoutes);
app.use('/payment-flow', authenticate, paymentFlowRoutes(upload));

app.use(errorHandler);

export default app;
// validatorAI/index.js
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import helmet from 'helmet';
import authenticate from '../middlewares/authMiddleware.js';
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
// /validator é chamado server-to-server pelo job de análise automática de contratos
// (sem usuário no fluxo) — protegido apenas por CORS/rede interna.
app.use('/validator', documentRoutes(upload));
app.use('/validator/history', authenticate, historyRoutes);
app.use('/chat', authenticate, chatRoutes);
app.use('/token', authenticate, statsRoutes);
app.use('/payment-flow', authenticate, paymentFlowRoutes(upload));

app.use(errorHandler);

export default app;
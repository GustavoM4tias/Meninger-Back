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

// Rotas
app.use('/validator', documentRoutes(upload));
app.use('/validator/history', authenticate, historyRoutes);
app.use('/chat', chatRoutes);
app.use('/token', statsRoutes);

app.use(errorHandler);

export default app;
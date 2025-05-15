// /server.js
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import authRoutes from './routes/authRoutes.js';
import eventRoutes from './routes/eventRoutes.js';
import favoriteRoutes from './routes/favoriteRoutes.js';
import externalApiRoutes from './routes/externalApiRoutes.js';

dotenv.config();
const app = express();

const corsOptions = {
  origin: [
    'http://localhost:5173',
    'https://meninger.vercel.app'
  ],
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  credentials: true
};

app.use(express.json());

// 1️⃣ Responde sempre OPTIONS em todas as rotas
app.options('*', cors(corsOptions));

// 2️⃣ Aplica o CORS normal
app.use(cors(corsOptions));

// Rotas
app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/favorite', favoriteRoutes);
app.use('/api/external', externalApiRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta: ${PORT}`);
});

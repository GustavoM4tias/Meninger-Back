// /server.js
import 'mysql2';            // <- força inclusão no bundle
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import authRoutes from './routes/authRoutes.js';
import eventRoutes from './routes/eventRoutes.js';
import favoriteRoutes from './routes/favoriteRoutes.js';
import cvRoutes from './routes/cvRoutes.js';
import siengeRoutes from './routes/siengeRoutes.js';

dotenv.config();
const app = express();

// CORS precisa estar no topo, ANTES de qualquer rota
const corsOptions = {
  origin: [
    'http://localhost:5173',
    'https://meninger.vercel.app'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// Rotas
app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/favorite', favoriteRoutes);
app.use('/api/cv', cvRoutes);
app.use('/api/sienge', siengeRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta: ${PORT}`);
});

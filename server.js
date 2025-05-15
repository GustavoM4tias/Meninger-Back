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
app.use(express.json());
app.use(cors({
  origin: ['http://localhost:5173','https://meninger.vercel.app'],
  methods: ['GET','POST','PUT','DELETE'],
  credentials: true,
}));

// Rotas
app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/favorite', favoriteRoutes);
app.use('/api/external', externalApiRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta: ${PORT}`);
});

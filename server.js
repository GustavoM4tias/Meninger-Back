// api/server.js
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import db from './config/db.js';
import authRoutes from './routes/authRoutes.js';
import eventRoutes from './routes/eventRoutes.js';
import buildingRoutes from './routes/buildingRoutes.js';
import favoriteRoutes from './routes/favoriteRoutes.js';
import externalApiRoutes from './routes/externalApiRoutes.js';


dotenv.config();

const app = express();
app.use(express.json());

// Usar CORS
app.use(cors({
  origin: ['http://localhost:5173', 'https://meninger.vercel.app'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
}));

// Middleware para adicionar `req.db` em cada requisição
app.use((req, res, next) => {
  req.db = db;
  next();
});

// Rotas
app.use('/api/auth', authRoutes);

app.use('/api/events', eventRoutes);

app.use('/api/buildings', buildingRoutes);

app.use('/api/favorite', favoriteRoutes);

// Outras rotas...
app.use('/api/external', externalApiRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta: ${PORT}`);
});

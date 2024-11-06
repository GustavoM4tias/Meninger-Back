// api/server.js
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import db from './config/db.js';
import authRoutes from './routes/authRoutes.js';
import eventRoutes from './routes/eventRoutes.js';

dotenv.config();

const app = express();
app.use(express.json());

// Usar CORS
app.use(cors({
  origin: 'http://localhost:5173', 
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
}));

// app.use(cors({
//   origin: 'https://meninger.vercel.app', 
//   methods: ['GET', 'POST', 'PUT', 'DELETE'],
//   credentials: true,
// }));

// Middleware para adicionar `req.db` em cada requisição
app.use((req, res, next) => {
  req.db = db;
  next();
});

// Rotas
app.use('/api/auth', authRoutes);

app.use('/api/events', eventRoutes);


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

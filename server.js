// /server.js
// import 'mysql2';            // <- força inclusão no bundle
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import db from './models/sequelize/index.js';
import authRoutes from './routes/authRoutes.js';
import eventRoutes from './routes/eventRoutes.js';
import favoriteRoutes from './routes/favoriteRoutes.js';
import cvRoutes from './routes/cvRoutes.js';
import siengeRoutes from './routes/siengeRoutes.js';
import validatorAI from './validatorAI/index.js';

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

// chatbot ai
app.use('/api/ai', validatorAI);

const PORT = process.env.PORT || 5000;

db.sequelize.sync({ alter: true })  // ⚠️ alter: true = adapta sem apagar dados
  .then(() => {
    console.log('Banco sincronizado com sucesso!');
    app.listen(PORT, () => {
      console.log(`Servidor rodando na porta: ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Erro ao sincronizar o banco:', err);
  });

//   | Ambiente        | Método recomendado            | Observações                             |
// | --------------- | ----------------------------- | --------------------------------------- |
// | Desenvolvimento | `sync({ force: true })`       | Recria do zero sempre, útil para testar |
// | Desenvolvimento | `sync({ alter: true })`       | Adapta estrutura sem perder dados       |
// | Produção        | `sync()` ou migrações via CLI | Use migrações para controle total       |


// app.listen(PORT, () => {
//   console.log(`Servidor rodando na porta: ${PORT}`);
// });

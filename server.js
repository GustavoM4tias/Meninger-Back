// /server.js
// import 'mysql2';            // <- força inclusão no bundle
import express from 'express';
import dotenv from 'dotenv';
dotenv.config();
import cors from 'cors';
import db from './models/sequelize/index.js';
import authRoutes from './routes/authRoutes.js'; 
import eventRoutes from './routes/eventRoutes.js';
import favoriteRoutes from './routes/favoriteRoutes.js';
import cvRoutes from './routes/cvRoutes.js';
import siengeRoutes from './routes/siengeRoutes.js';
import validatorAI from './validatorAI/index.js';
import contractAutomationRoutes from './routes/contractAutomationRoutes.js';
import microsoftAuthRoutes from './routes/microsoftAuthRoutes.js';
import externalRoutes from './routes/externalRoutes.js'
import expensesRoutes from './routes/expensesRoutes.js';

// cron 
import contractValidatorScheduler from './scheduler/contractValidatorScheduler.js';
import contractSiengeScheduler from './scheduler/contractSiengeScheduler.js';
import leadCvScheduler from './scheduler/leadCvScheduler.js';
import repasseCvScheduler from './scheduler/repasseCvScheduler.js';
import reservaCvScheduler from './scheduler/reservaCvScheduler.js';
import landScheduler from './scheduler/landScheduler.js';

import admin from './routes/admin.js';

import supportRoutes from './routes/supportRoutes.js';

import projectionRoutes from './routes/projectionsRoutes.js';

import enterpriseCvScheduler from './scheduler/enterpriseCvScheduler.js'; 


const app = express();

// CORS precisa estar no topo, ANTES de qualquer rota
const corsOptions = {
  origin: [
    'http://localhost:5173',
    'https://meninger.vercel.app',
    'https://office.menin.com.br'
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], // 👈 adicione PATCH
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

app.use('/api/admin', admin);

// Rotas
app.use('/api/auth', authRoutes);  
app.use('/api/events', eventRoutes);
app.use('/api/favorite', favoriteRoutes);
app.use('/api/cv', cvRoutes);
app.use('/api/sienge', siengeRoutes); // Sienge api, db and cron
app.use('/api/microsoft', microsoftAuthRoutes);// Microsoft for archives
app.use('/api/ai', validatorAI);// chatbot ai
app.use('/api/contracts', contractAutomationRoutes);
app.use('/api/external', externalRoutes);

app.use('/api/support', supportRoutes);

app.use('/api/projections', projectionRoutes);

app.use('/api/expenses', expensesRoutes);

const PORT = process.env.PORT || 5000;

db.sequelize.sync({ alter: false })  // ⚠️ alter: true = adapta sem apagar dados
  .then(() => {
    console.log('Banco sincronizado com sucesso!');

    // Start schedulers só depois do sync:
    if (process.env.ENABLE_CONTRACT_SCHEDULE === 'true') {
      contractValidatorScheduler.start();
    }
    if (process.env.ENABLE_SIENGE_CONTRACT_SCHEDULE === 'true') {
      contractSiengeScheduler.start();
    }
    if (process.env.ENABLE_CV_LEAD_SCHEDULE === 'true') {
      leadCvScheduler.start();
    }
    if (process.env.ENABLE_CV_REPASSE_SCHEDULE === 'true') {
      repasseCvScheduler.start();
    }
    if (process.env.ENABLE_CV_RESERVA_SCHEDULE === 'true') {  // 👈 NOVO
      reservaCvScheduler.start();
    }
    if (process.env.ENABLE_LAND_CONTRACT_SCHEDULE === 'true') {  // 👈 NOVO
      landScheduler.start();
    }
    // ...
    if (process.env.ENABLE_CV_ENTERPRISE_SCHEDULE === 'true') {
      enterpriseCvScheduler.start();
    } 

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

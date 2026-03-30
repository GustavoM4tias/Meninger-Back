// /server.js 
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
import admin from './routes/admin.js'; 
import supportRoutes from './routes/supportRoutes.js'; 
import projectionRoutes from './routes/projectionsRoutes.js';
import expensesRoutes from './routes/expensesRoutes.js';
import viabilityRoutes from './routes/viabilityRoutes.js';
import academyRoutes from './routes/academyRoutes.js'; 
import uploadRoutes from './routes/uploadRoutes.js';
import bucketUploadRoutes from './routes/bucketUploadRoutes.js';
import permissionRoutes from './routes/permissionRoutes.js';

import { seedInitialTypes } from './controllers/sienge/launchTypeController.js';
import contractValidatorScheduler from './scheduler/contractValidatorScheduler.js';
import contractSiengeScheduler from './scheduler/contractSiengeScheduler.js';
import leadCvScheduler from './scheduler/leadCvScheduler.js';
import repasseCvScheduler from './scheduler/repasseCvScheduler.js';
import reservaCvScheduler from './scheduler/reservaCvScheduler.js';
import landScheduler from './scheduler/landScheduler.js';
import enterpriseCvScheduler from './scheduler/enterpriseCvScheduler.js';
import creditorPollingScheduler from './scheduler/creditorPollingScheduler.js';
import contractApprovalScheduler from './scheduler/contractApprovalScheduler.js';
import leadCancelReasonScheduler from './scheduler/leadCancelReasonScheduler.js';
import supabaseKeepAliveScheduler from './scheduler/supabaseKeepAliveScheduler.js';

const app = express();

// CORS precisa estar no topo, ANTES de qualquer rota
const corsOptions = {
  origin: [
    'http://localhost:5173',
    'https://meninger.vercel.app',
    'https://office.menin.com.br',
    'https://academy.menin.com.br'
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], // 👈 adicione PATCH
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

app.use('/api/admin', admin);
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
app.use('/api/viability', viabilityRoutes);
app.use('/api/academy', academyRoutes); 
app.use('/api/uploads', uploadRoutes);
app.use('/api/bucket-upload', bucketUploadRoutes);
app.use('/api/permissions', permissionRoutes);

const PORT = process.env.PORT || 5000;

db.sequelize.sync({ alter: false })
  .then(async () => {
    console.log('Banco sincronizado com sucesso!');
    await bootServer();
  })
  .catch(async (err) => {
    // ECONNRESET em conexões remotas durante ALTER TABLE — tabelas críticas sincronizadas separadamente
    if (err?.parent?.code === 'ECONNRESET' || err?.original?.code === 'ECONNRESET') {
      console.warn('⚠️  Sync interrompido por ECONNRESET — forçando sync das tabelas críticas...');
      for (const [name, model] of [['User', db.User], ['PaymentLaunch', db.PaymentLaunch]]) {
        try {
          await model.sync({ alter: true });
          console.log(`✅ ${name} sincronizado.`);
        } catch (e) {
          console.warn(`⚠️  Falha ao sincronizar ${name}:`, e.message);
        }
      }
      await bootServer();
    } else {
      console.error('Erro ao sincronizar o banco:', err);
    }
  });

async function bootServer() {
  // Garante que tabelas críticas tenham todas as colunas atualizadas
  for (const [name, model] of [
    ['User', db.User],                                    // microsoft_id + outros campos novos
    ['PaymentLaunch', db.PaymentLaunch],
    ['SiengeBill', db.SiengeBill],
    ['SiengeBillInstallment', db.SiengeBillInstallment],
    ['Lead', db.Lead],                                    // motivo_cancelamento + submotivo_cancelamento
    ['BucketUploadHistory', db.BucketUploadHistory],
    ['UserPermission', db.UserPermission],
  ]) {
    try {
      await model.sync({ alter: true });
      console.log(`✅ ${name} sincronizado.`);
    } catch (e) {
      console.warn(`⚠️  Falha ao sincronizar ${name}:`, e.message);
    }
  }

  await seedInitialTypes();

  if (process.env.ENABLE_CONTRACT_SCHEDULE === 'true') contractValidatorScheduler.start();
  if (process.env.ENABLE_SIENGE_CONTRACT_SCHEDULE === 'true') contractSiengeScheduler.start();
  if (process.env.ENABLE_CV_LEAD_SCHEDULE === 'true') leadCvScheduler.start();
  if (process.env.ENABLE_CV_REPASSE_SCHEDULE === 'true') repasseCvScheduler.start();
  if (process.env.ENABLE_CV_RESERVA_SCHEDULE === 'true') reservaCvScheduler.start();
  if (process.env.ENABLE_LAND_CONTRACT_SCHEDULE === 'true') landScheduler.start();
  if (process.env.ENABLE_CV_ENTERPRISE_SCHEDULE === 'true') enterpriseCvScheduler.start();
  creditorPollingScheduler.start();
  contractApprovalScheduler.start();
  supabaseKeepAliveScheduler.start();
  if (process.env.ENABLE_CV_LEAD_SCHEDULE === 'true') leadCancelReasonScheduler.start();

  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta: ${PORT}`);
  });
}

//   | Ambiente        | Método recomendado            | Observações                             |
// | --------------- | ----------------------------- | --------------------------------------- |
// | Desenvolvimento | `sync({ force: true })`       | Recria do zero sempre, útil para testar |
// | Desenvolvimento | `sync({ alter: true })`       | Adapta estrutura sem perder dados       |
// | Produção        | `sync()` ou migrações via CLI | Use migrações para controle total       |

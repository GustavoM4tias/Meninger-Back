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
import signatureRoutes from './routes/signatureRoutes.js';
import signatureDocumentRoutes from './routes/signatureDocumentRoutes.js';
import conditionsRoutes from './routes/conditionsRoutes.js';
import boletoRoutes from './routes/boletoRoutes.js';
import mcmvRoutes from './routes/mcmvRoutes.js';
import officeChatRoutes from './routes/officeChatRoutes.js';
import academyChatRoutes from './routes/academyChatRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import whatsappRoutes from './routes/whatsappRoutes.js';
import whatsappWebhookRoutes from './routes/whatsappWebhookRoutes.js';
import marketingPublicRoutes from './routes/marketingPublicRoutes.js';
import marketingWebhookRoutes from './routes/marketingWebhookRoutes.js';
import marketingRoutes from './routes/marketingRoutes.js';
import alertRoutes from './routes/alertRoutes.js';

import { seedInitialTypes } from './controllers/sienge/launchTypeController.js';
import contractValidatorScheduler from './scheduler/contractValidatorScheduler.js';
import contractSiengeScheduler from './scheduler/contractSiengeScheduler.js';
import leadCvScheduler from './scheduler/leadCvScheduler.js';
import repasseCvScheduler from './scheduler/repasseCvScheduler.js';
import reservaCvScheduler from './scheduler/reservaCvScheduler.js';
import reservaCvSweepScheduler from './scheduler/reservaCvSweepScheduler.js';
import landScheduler from './scheduler/landScheduler.js';
import enterpriseCvScheduler from './scheduler/enterpriseCvScheduler.js';
import precadastroCvScheduler from './scheduler/precadastroCvScheduler.js';
import creditorPollingScheduler from './scheduler/creditorPollingScheduler.js';
import contractApprovalScheduler from './scheduler/contractApprovalScheduler.js';
import leadCancelReasonScheduler from './scheduler/leadCancelReasonScheduler.js';
import supabaseKeepAliveScheduler from './scheduler/supabaseKeepAliveScheduler.js';
import cvExtrasScheduler from './scheduler/cvExtrasScheduler.js';
import conditionAutoGenerateScheduler from './scheduler/conditionAutoGenerateScheduler.js';
import boletoCleanupScheduler from './scheduler/boletoCleanupScheduler.js';
import siengeBackupScheduler from './scheduler/siengeBackupScheduler.js';
import billsAutoSyncScheduler from './scheduler/billsAutoSyncScheduler.js';
import marketingDispatchScheduler from './scheduler/marketingDispatchScheduler.js';
import marketingSyncScheduler     from './scheduler/marketingSyncScheduler.js';
import { ensureBillsAutoSyncSchema } from './lib/ensureBillsAutoSyncSchema.js';
import { ensureMarketingCaptureSchema } from './lib/ensureMarketingCaptureSchema.js';
import { ensureSiengeBackupLogSchema } from './lib/ensureSiengeBackupLogSchema.js';
import { ensureBoletoSchema } from './lib/ensureBoletoSchema.js';
import { ensureAcademyPreSync, ensureAcademyPostSync } from './lib/ensureAcademySchema.js';
import eventReminderScheduler from './scheduler/eventReminderScheduler.js';
import { startAcademyDeadlineScheduler } from './scheduler/academyDeadlineScheduler.js';
import { startAcademyRecertifyScheduler } from './scheduler/academyRecertifyScheduler.js';
import { startAcademyOnboardingScheduler } from './scheduler/academyOnboardingScheduler.js';
import AlertEngine from './services/alerts/AlertEngine.js';

const app = express();

// CORS precisa estar no topo, ANTES de qualquer rota
const corsOptions = {
  origin: [
    'http://localhost:5173',
    'http://lp.localhost:5173',
    'http://academy.localhost:5173',
    'https://meninger.vercel.app',
    'https://office.menin.com.br',
    'https://lp.menin.com.br',
    'https://academy.menin.com.br'
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], // 👈 adicione PATCH
  credentials: true
};

app.use(cors(corsOptions));

// ⚠️ Webhook do WhatsApp precisa do raw body para validar HMAC.
// Por isso é montado ANTES do express.json() global.
app.use('/api/whatsapp/webhook', whatsappWebhookRoutes);

// Captação de marketing — endpoints públicos (CORS aberto + body parsers próprios).
// Montado ANTES do express.json() global; o router traz seus próprios parsers.
app.use('/api/marketing/public', marketingPublicRoutes);

// Webhook do Meta Lead Ads — precisa do raw body para validar o HMAC.
app.use('/api/marketing/webhook', marketingWebhookRoutes);

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
app.use('/api/signatures', signatureRoutes);
app.use('/api/signature-documents', signatureDocumentRoutes);
app.use('/api/conditions', conditionsRoutes);
app.use('/api/boleto-caixa', boletoRoutes);
app.use('/api/mcmv', mcmvRoutes);
app.use('/api/office-chat', officeChatRoutes);
app.use('/api/academy-chat', academyChatRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/marketing', marketingRoutes);

const PORT = process.env.PORT || 5000;

// Academy: dedup + drop UNIQUE antiga ANTES do sync, para que os models novos
// possam recriar a UNIQUE correta sem conflito com dados/índices antigos.
ensureAcademyPreSync()
  .catch(err => console.warn('⚠️  Academy pre-sync falhou:', err.message))
  .finally(() => db.sequelize.sync({ alter: false }))
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

  // Sync alter só pros models que estão em evolução ativa.
  // Os demais (User, Academy, Alerts, Eme, etc.) já estabilizaram — pode rodar
  // sync normal via db.sequelize.sync({ alter: false }) no boot, que cria
  // tabelas novas sem alterar as existentes.
  for (const [name, model] of [
    // Marketing — Captação de Leads (em evolução: forms, campanhas, ads)
    ['LeadForm', db.LeadForm],
    ['MetaLeadForm', db.MetaLeadForm],
    ['MetaCampaign', db.MetaCampaign],
    ['MetaAd', db.MetaAd],
  ]) {
    if (!model) continue;
    try {
      await model.sync({ alter: true });
      console.log(`✅ ${name} sincronizado.`);
    } catch (e) {
      console.warn(`⚠️  Falha ao sincronizar ${name}:`, e.message);
    }
  }

  // Patch defensivo: ALTER TABLE ADD COLUMN IF NOT EXISTS para campos novos.
  // Cobre casos onde sync({ alter: true }) falha silenciosamente (ENUM, etc.).
  // Idempotente — pode rodar a cada boot sem efeito colateral.
  await ensureBillsAutoSyncSchema();
  await ensureSiengeBackupLogSchema();
  await ensureBoletoSchema();
  await ensureAcademyPostSync();
  await ensureMarketingCaptureSchema();

  await seedInitialTypes();

  if (process.env.ENABLE_CONTRACT_SCHEDULE === 'true') contractValidatorScheduler.start();
  if (process.env.ENABLE_SIENGE_CONTRACT_SCHEDULE === 'true') contractSiengeScheduler.start();
  if (process.env.ENABLE_CV_LEAD_SCHEDULE === 'true') leadCvScheduler.start();
  if (process.env.ENABLE_CV_REPASSE_SCHEDULE === 'true') repasseCvScheduler.start();
  if (process.env.ENABLE_CV_RESERVA_SCHEDULE === 'true') reservaCvScheduler.start();
  if (process.env.ENABLE_CV_RESERVA_SWEEP_SCHEDULE === 'true') reservaCvSweepScheduler.start();
  if (process.env.ENABLE_LAND_CONTRACT_SCHEDULE === 'true') landScheduler.start();
  if (process.env.ENABLE_CV_ENTERPRISE_SCHEDULE === 'true') enterpriseCvScheduler.start();
  if (process.env.ENABLE_CV_PRECADASTRO_SCHEDULE === 'true') precadastroCvScheduler.start();
  creditorPollingScheduler.start();
  contractApprovalScheduler.start();
  supabaseKeepAliveScheduler.start();
  if (process.env.ENABLE_CV_LEAD_SCHEDULE === 'true') leadCancelReasonScheduler.start();
  if (process.env.ENABLE_CV_EXTRAS_SCHEDULE !== 'false') cvExtrasScheduler.start(); // ativo por padrão
  conditionAutoGenerateScheduler.start(); // auto-geração de fichas + polling de assinaturas
  boletoCleanupScheduler.start();         // remove boletos expirados do Supabase
  if (process.env.ENABLE_SIENGE_BACKUP_SCHEDULE === 'true') siengeBackupScheduler.start();
  if (process.env.ENABLE_BILLS_AUTO_SYNC === 'true') billsAutoSyncScheduler.start();
  eventReminderScheduler.start();         // lembretes de evento (D-1) via NotificationService
  startAcademyDeadlineScheduler();        // lembretes de trilhas obrigatórias (D-3/D-1/D0/OVERDUE)
  startAcademyRecertifyScheduler();       // recertificação periódica (expira certificado + reassign mandatory)
  startAcademyOnboardingScheduler();      // aplica regras de onboarding (auto-atribui trilhas)
  if (process.env.ENABLE_MARKETING_CAPTURE !== 'false') marketingDispatchScheduler.start(); // re-tenta despacho de leads ao CV
  marketingSyncScheduler.start(); // sync Meta (forms/campanhas/ads/leads) — full a cada 2h em horário comercial + light 15/15min
  await AlertEngine.boot();               // registra crons das alert_rules salvas

  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta: ${PORT}`);
  });
}

//   | Ambiente        | Método recomendado            | Observações                             |
// | --------------- | ----------------------------- | --------------------------------------- |
// | Desenvolvimento | `sync({ force: true })`       | Recria do zero sempre, útil para testar |
// | Desenvolvimento | `sync({ alter: true })`       | Adapta estrutura sem perder dados       |
// | Produção        | `sync()` ou migrações via CLI | Use migrações para controle total       |

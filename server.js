// /server.js 
import express from 'express';
import dotenv from 'dotenv';
dotenv.config();
import cors from 'cors';
import helmet from 'helmet';
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
import conditionsRoutes from './routes/conditionsRoutes.js';
import boletoRoutes from './routes/boletoRoutes.js';
import shortLinkRoutes from './routes/shortLinkRoutes.js';
import mcmvRoutes from './routes/mcmvRoutes.js';
import officeChatRoutes from './routes/officeChatRoutes.js';
import officeBrainRoutes from './routes/officeBrainRoutes.js';
import whatsappAutomationRoutes from './routes/whatsappAutomationRoutes.js';
import academyChatRoutes from './routes/academyChatRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import whatsappRoutes from './routes/whatsappRoutes.js';
import whatsappWebhookRoutes from './routes/whatsappWebhookRoutes.js';
import marketingPublicRoutes from './routes/marketingPublicRoutes.js';
import marketingWebhookRoutes from './routes/marketingWebhookRoutes.js';
import marketingRoutes from './routes/marketingRoutes.js';
import alertRoutes from './routes/alertRoutes.js';
import bolaoRoutes from './routes/bolaoRoutes.js';

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
import boletoPaymentCheckScheduler from './scheduler/boletoPaymentCheckScheduler.js';
import boletoSituacaoApplyScheduler from './scheduler/boletoSituacaoApplyScheduler.js';
import siengeBackupScheduler from './scheduler/siengeBackupScheduler.js';
import billsAutoSyncScheduler from './scheduler/billsAutoSyncScheduler.js';
import marketingDispatchScheduler from './scheduler/marketingDispatchScheduler.js';
import marketingSyncScheduler     from './scheduler/marketingSyncScheduler.js';
import { ensureBillsAutoSyncSchema } from './lib/ensureBillsAutoSyncSchema.js';
import { ensureMarketingCaptureSchema } from './lib/ensureMarketingCaptureSchema.js';
import { ensureSiengeBackupLogSchema } from './lib/ensureSiengeBackupLogSchema.js';
import { ensureEmeBrainSchema } from './lib/ensureEmeBrainSchema.js';
import { ensureWhatsappAutomationSchema } from './lib/ensureWhatsappAutomationSchema.js';
import { ensureViabilitySchema } from './lib/ensureViabilitySchema.js';
import { ensureBoletoSchema } from './lib/ensureBoletoSchema.js';
import { ensureBoletoWhatsappTemplate } from './lib/ensureBoletoWhatsappTemplate.js';
import { ensureAcademyPreSync, ensureAcademyPostSync } from './lib/ensureAcademySchema.js';
import { ensureComercialConditionsSchema } from './lib/ensureComercialConditionsSchema.js';
import eventReminderScheduler from './scheduler/eventReminderScheduler.js';
import bolaoLiveScheduler from './scheduler/bolaoLiveScheduler.js';
import seedBolaoCopa2026 from './services/bolao/seedBolaoCopa2026.js';
import { startAcademyDeadlineScheduler } from './scheduler/academyDeadlineScheduler.js';
import { startAcademyRecertifyScheduler } from './scheduler/academyRecertifyScheduler.js';
import { startAcademyOnboardingScheduler } from './scheduler/academyOnboardingScheduler.js';
import AlertEngine from './services/alerts/AlertEngine.js';

const app = express();

// ── Segurança base ────────────────────────────────────────────────────────────
// Falha cedo e alto se o segredo crítico faltar: ele assina os JWT e deriva a
// chave que cifra as credenciais Sienge. Sem ele, nada disso é seguro.
if (!process.env.JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET não definido. Configure a variável de ambiente antes de subir o servidor.');
  process.exit(1);
}

// Atrás do proxy do Railway/Vercel — confiar no 1º hop para que req.ip seja o IP
// real do cliente (necessário para rate-limit e logs corretos).
app.set('trust proxy', 1);

// Headers de segurança. CSP fica desligada por ora (o front roda em domínio
// separado; uma CSP estrita exige trabalho dedicado), mas o resto entra sem
// quebrar nada: HSTS, noSniff, anti-clickjacking, referrer-policy, etc.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
}));

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
app.use('/api/conditions', conditionsRoutes);
app.use('/api/boleto-caixa', boletoRoutes);
// Encurtador de URL público — rota fora de /api por elegância.
// Cliente que recebeu link curto via WhatsApp acessa `${host}/s/{slug}` e cai aqui.
app.use('/s', shortLinkRoutes);
app.use('/api/mcmv', mcmvRoutes);
app.use('/api/office-chat', officeChatRoutes);
app.use('/api/office-brain', officeBrainRoutes);
app.use('/api/whatsapp-automations', whatsappAutomationRoutes);
app.use('/api/academy-chat', academyChatRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/marketing', marketingRoutes);
app.use('/api/bolao', bolaoRoutes);

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
    ['MetaAdSet', db.MetaAdSet],
    // Bolão da Copa (novo módulo em evolução)
    ['Bolao', db.Bolao],
    ['BolaoMatch', db.BolaoMatch],
    ['BolaoParticipant', db.BolaoParticipant],
    ['BolaoPrediction', db.BolaoPrediction],
    // Viabilidade de Marketing — campo Custo Loja novo em sales_projection_enterprises
    ['SalesProjectionEnterprise', db.SalesProjectionEnterprise],
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
  await ensureEmeBrainSchema();
  await ensureWhatsappAutomationSchema();
  await ensureViabilitySchema();
  await ensureComercialConditionsSchema();

  await seedInitialTypes();

  // Provisiona template WhatsApp do boleto na Meta se faltar — assim em caso
  // de perda/recriação da conta Meta o sistema se auto-recupera. Idempotente.
  ensureBoletoWhatsappTemplate().catch(err =>
      console.warn('⚠️  ensureBoletoWhatsappTemplate falhou:', err.message));

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
  conditionAutoGenerateScheduler.start(); // auto-geração mensal de fichas (com e sem CV)
  boletoCleanupScheduler.start();         // remove boletos expirados do Supabase
  boletoPaymentCheckScheduler.start();    // 8h: verifica pagamento/baixa de boletos no Ecobrança
  boletoSituacaoApplyScheduler.start();   // 1min: aplica situações CV agendadas (delay lote Sienge)
  if (process.env.ENABLE_SIENGE_BACKUP_SCHEDULE === 'true') siengeBackupScheduler.start();
  if (process.env.ENABLE_BILLS_AUTO_SYNC === 'true') billsAutoSyncScheduler.start();
  eventReminderScheduler.start();         // lembretes de evento (D-1) via NotificationService
  startAcademyDeadlineScheduler();        // lembretes de trilhas obrigatórias (D-3/D-1/D0/OVERDUE)
  startAcademyRecertifyScheduler();       // recertificação periódica (expira certificado + reassign mandatory)
  startAcademyOnboardingScheduler();      // aplica regras de onboarding (auto-atribui trilhas)
  if (process.env.ENABLE_MARKETING_CAPTURE !== 'false') marketingDispatchScheduler.start(); // re-tenta despacho de leads ao CV
  marketingSyncScheduler.start(); // sync Meta (forms/campanhas/ads/leads) — full a cada 2h em horário comercial + light 15/15min
  if (process.env.ENABLE_BOLAO_LIVE !== 'false') bolaoLiveScheduler.start(); // placar ao vivo do bolão (poll ESPN na janela do jogo)
  if (process.env.SEED_BOLAO_COPA === 'true') {
    seedBolaoCopa2026().catch(err => console.warn('⚠️  seedBolaoCopa2026 falhou:', err.message));
  }
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

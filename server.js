// /server.js 
import express from 'express';
import dotenv from 'dotenv';
dotenv.config();
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
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
import deptSpendingRoutes from './routes/deptSpendingRoutes.js';
import academyRoutes from './routes/academyRoutes.js'; 
import uploadRoutes from './routes/uploadRoutes.js';
import bucketUploadRoutes from './routes/bucketUploadRoutes.js';
import permissionRoutes from './routes/permissionRoutes.js';
import orgRoutes from './routes/orgRoutes.js';
import orgRegistryScheduler from './scheduler/orgRegistryScheduler.js';
import reportExportLogRoutes from './routes/reportExportLogRoutes.js';
import conditionsRoutes from './routes/conditionsRoutes.js';
import eventPlanRoutes from './routes/eventPlanRoutes.js';
import docusignOauthRoutes from './routes/docusignOauthRoutes.js';
import boletoRoutes from './routes/boletoRoutes.js';
import reservaCancelRoutes from './routes/reservaCancelRoutes.js';
import shortLinkRoutes from './routes/shortLinkRoutes.js';
import mcmvRoutes from './routes/mcmvRoutes.js';
import officeChatRoutes from './routes/officeChatRoutes.js';
import officeBrainRoutes from './routes/officeBrainRoutes.js';
import whatsappAutomationRoutes from './routes/whatsappAutomationRoutes.js';
import emeAtendeRoutes from './routes/emeAtendeRoutes.js';
import emeAtendePublicRoutes from './routes/emeAtendePublicRoutes.js';
import { ensureEmeAtendeSeed } from './services/emeAtende/emeAtendeSeed.js';
import academyChatRoutes from './routes/academyChatRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import whatsappRoutes from './routes/whatsappRoutes.js';
import whatsappWebhookRoutes from './routes/whatsappWebhookRoutes.js';
import marketingPublicRoutes from './routes/marketingPublicRoutes.js';
import realEstateRoutes from './routes/realEstateRoutes.js';
import realEstatePublicRoutes from './routes/realEstatePublicRoutes.js';
import correspondentRoutes from './routes/correspondentRoutes.js';
import correspondentPublicRoutes from './routes/correspondentPublicRoutes.js';
import correspondentCvScheduler from './scheduler/correspondentCvScheduler.js';
import emeReportsRoutes from './routes/emeReportsRoutes.js';
import emeReportsPublicRoutes from './routes/emeReportsPublicRoutes.js';
import marketingWebhookRoutes from './routes/marketingWebhookRoutes.js';
import marketingRoutes from './routes/marketingRoutes.js';
import marketingApprovalRoutes from './routes/marketingApprovalRoutes.js';
import salesStandRoutes from './routes/salesStandRoutes.js';
import salesClosingRoutes from './routes/salesClosingRoutes.js';
import metaAppRoutes from './routes/metaAppRoutes.js';
import { campaignsOAuthCallback as metaCampaignsOAuthCallback } from './controllers/meta/metaAppConfigController.js';
import alertRoutes from './routes/alertRoutes.js';
import bolaoRoutes from './routes/bolaoRoutes.js';
import bolaoPublicRoutes from './routes/bolaoPublicRoutes.js';
import comunicadoRoutes from './routes/comunicadoRoutes.js';
import checklistRoutes from './routes/checklistRoutes.js';
import organogramRoutes from './routes/organogramRoutes.js';

import { seedInitialTypes } from './controllers/sienge/launchTypeController.js';
import { seedSalesStandModels } from './services/marketing/salesStandService.js';
import seedChecklist from './services/checklist/seedChecklist.js';
import contractValidatorScheduler from './scheduler/contractValidatorScheduler.js';
import contractSiengeScheduler from './scheduler/contractSiengeScheduler.js';
import salesClosingScheduler from './scheduler/salesClosingScheduler.js';
import leadCvScheduler from './scheduler/leadCvScheduler.js';
import repasseCvScheduler from './scheduler/repasseCvScheduler.js';
import reservaCvScheduler from './scheduler/reservaCvScheduler.js';
import reservaCvSweepScheduler from './scheduler/reservaCvSweepScheduler.js';
import reservaCvGapScheduler from './scheduler/reservaCvGapScheduler.js';
import landScheduler from './scheduler/landScheduler.js';
import enterpriseCvScheduler from './scheduler/enterpriseCvScheduler.js';
import precadastroCvScheduler from './scheduler/precadastroCvScheduler.js';
import creditorPollingScheduler from './scheduler/creditorPollingScheduler.js';
import contractApprovalScheduler from './scheduler/contractApprovalScheduler.js';
import leadCancelReasonScheduler from './scheduler/leadCancelReasonScheduler.js';
import supabaseKeepAliveScheduler from './scheduler/supabaseKeepAliveScheduler.js';
import cvExtrasScheduler from './scheduler/cvExtrasScheduler.js';
import conditionAutoGenerateScheduler from './scheduler/conditionAutoGenerateScheduler.js';
import eventPlanCycleScheduler from './scheduler/eventPlanCycleScheduler.js';
import boletoCleanupScheduler from './scheduler/boletoCleanupScheduler.js';
import boletoPaymentCheckScheduler from './scheduler/boletoPaymentCheckScheduler.js';
import boletoSituacaoApplyScheduler from './scheduler/boletoSituacaoApplyScheduler.js';
import siengeBackupScheduler from './scheduler/siengeBackupScheduler.js';
import marketingDispatchScheduler from './scheduler/marketingDispatchScheduler.js';
import marketingSyncScheduler     from './scheduler/marketingSyncScheduler.js';
import { ensureFinanceOverridesSchema } from './lib/ensureFinanceOverridesSchema.js';
import { ensureMarketingCaptureSchema } from './lib/ensureMarketingCaptureSchema.js';
import { ensureSiengeBackupLogSchema } from './lib/ensureSiengeBackupLogSchema.js';
import { ensureEmeBrainSchema } from './lib/ensureEmeBrainSchema.js';
import { ensureEmeReportsSchema } from './lib/ensureEmeReportsSchema.js';
import { ensureWhatsappAutomationSchema } from './lib/ensureWhatsappAutomationSchema.js';
import { ensureWhatsappMessagesSchema } from './lib/ensureWhatsappMessagesSchema.js';
import { ensureAlertSharesSchema } from './lib/ensureAlertSharesSchema.js';
import { ensureDeptSpendingSchema } from './lib/ensureDeptSpendingSchema.js';
import { ensureDepartmentVisibilitySchema } from './lib/ensureDepartmentVisibilitySchema.js';
import { ensureBoletoSchema } from './lib/ensureBoletoSchema.js';
import { ensureReservaCancelSchema } from './lib/ensureReservaCancelSchema.js';
import { ensureBoletoWhatsappTemplate } from './lib/ensureBoletoWhatsappTemplate.js';
import { ensureChecklistWhatsappTemplates } from './lib/ensureChecklistWhatsappTemplates.js';
import { ensureMarketingApprovalWhatsappTemplates } from './lib/ensureMarketingApprovalWhatsappTemplates.js';
import { ensureAcademyPreSync, ensureAcademyPostSync } from './lib/ensureAcademySchema.js';
import { ensureComercialConditionsSchema } from './lib/ensureComercialConditionsSchema.js';
import { ensureChecklistSchema } from './lib/ensureChecklistSchema.js';
import { ensureOrganogramSchema } from './lib/ensureOrganogramSchema.js';
import { ensureFaturamentoRulesSchema } from './lib/ensureFaturamentoRulesSchema.js';
import { ensureProjectionLinkSchema } from './lib/ensureProjectionLinkSchema.js';
import { ensureEmeAuditSchema } from './lib/ensureEmeAuditSchema.js';
import { ensurePermissionRouteRenames } from './lib/ensurePermissionRouteRenames.js';
import { ensureSignupApprovalColumns, seedDepartmentDefaultProfiles } from './lib/ensureSignupApprovalSchema.js';
import { ensureLegacyDrops } from './lib/ensureLegacyDrops.js';
import { ensureAccessModelSchema } from './lib/ensureAccessModelSchema.js';
import { ensureAccessModelColumns } from './lib/ensureAccessModelColumns.js';
import { ensureRoutePolicySchema } from './lib/ensureRoutePolicySchema.js';
import { ensureEventPlanSchema } from './lib/ensureEventPlanSchema.js';
import { ensureOrgDefaultsSchema } from './lib/ensureOrgDefaultsSchema.js';
import { ensureBrazilCitiesSeed } from './lib/ensureBrazilCitiesSeed.js';
import { registerApp as registerIntegrityApp, runIntegrityCheck } from './security/integrityCheck.js';
import { schemaDriftCheck } from './lib/schemaDriftCheck.js';
import { shouldRunSchemaSync, recordSchemaSync } from './lib/schemaSyncGate.js';
import eventReminderScheduler from './scheduler/eventReminderScheduler.js';
import bolaoLiveScheduler from './scheduler/bolaoLiveScheduler.js';
import reportPublicExpiryScheduler from './scheduler/reportPublicExpiryScheduler.js';
import seedBolaoCopa2026 from './services/bolao/seedBolaoCopa2026.js';
import seedBolaoPublico from './services/bolao/seedBolaoPublico.js';
import seedBolaoJapao from './services/bolao/seedBolaoJapao.js';
import { startAcademyDeadlineScheduler } from './scheduler/academyDeadlineScheduler.js';
import { startAcademyRecertifyScheduler } from './scheduler/academyRecertifyScheduler.js';
import { startAcademyOnboardingScheduler } from './scheduler/academyOnboardingScheduler.js';
import academyDigestScheduler from './scheduler/academyDigestScheduler.js';
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

// Compressão gzip/brotli das respostas. Essencial para os endpoints que devolvem
// JSON grande (ex.: /api/expenses em períodos longos — dezenas de MB caem ~90%).
// Só comprime a partir de 1KB e respeita Accept-Encoding do cliente.
app.use(compression({ threshold: 1024 }));

// Bolão da torcida — endpoints PÚBLICOS (menin.com.br/bolao). Montado ANTES do
// CORS global de propósito: a página pública pode rodar em QUALQUER domínio
// (apex menin.com.br, etc.), que não está na lista de origens do corsOptions.
// O router traz seu próprio cors({ origin: true }), então ele responde o
// preflight OPTIONS com o Access-Control-Allow-Origin correto. Se ficasse depois
// do cors global, o preflight de um POST application/json seria barrado (204 sem
// ACAO) antes de chegar aqui. Traz parser próprio e nunca exige token.
app.use('/api/bolao/public', bolaoPublicRoutes);

// CORS precisa estar no topo, ANTES de qualquer rota
const corsOptions = {
  origin: [
    'http://localhost:5173',
    'http://lp.localhost:5173',
    'http://academy.localhost:5173',
    'https://meninger.vercel.app',
    'https://office.menin.com.br',
    'https://lp.menin.com.br',
    'https://bolao-menin.vercel.app',
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

// Cadastro de imobiliária via link público — mesmo padrão (CORS aberto +
// parsers próprios + rate limit; segurança = token de convite de uso único).
app.use('/api/realestate/public', realEstatePublicRoutes);
app.use('/api/correspondents/public', correspondentPublicRoutes);

// Link público de Relatórios da Eme — mesmo padrão (CORS aberto + rate limit;
// segurança = token CSPRNG + vencimento obrigatório, 404 genérico, noindex).
app.use('/api/reports/public', emeReportsPublicRoutes);

// Webhook do Meta Lead Ads — precisa do raw body para validar o HMAC.
app.use('/api/marketing/webhook', marketingWebhookRoutes);

// Limite padrão (100kb) é pouco para o envio de assinatura: o body leva o HTML
// completo da ficha com QR codes em data URL e estourava em 413 Payload Too Large.
app.use(express.json({ limit: '10mb' }));

app.use('/api/admin', admin);
app.use('/api/meta-app', metaAppRoutes);   // credenciais de App Meta (compartilhadas WhatsApp + Lead Ads)
// Callback PÚBLICO do OAuth de campanhas — a Meta redireciona o navegador (sem JWT do app);
// segurança via `state` assinado, validado no controller.
app.get('/api/meta-app-oauth/campaigns/callback', metaCampaignsOAuthCallback);
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
app.use('/api/dept-spending', deptSpendingRoutes);
app.use('/api/academy', academyRoutes); 
app.use('/api/uploads', uploadRoutes);
app.use('/api/bucket-upload', bucketUploadRoutes);
app.use('/api/permissions', permissionRoutes);
app.use('/api/org', orgRoutes); // rótulos do registro unificado (escopados por usuário)
app.use('/api/report-exports', reportExportLogRoutes);   // trilha de exportações (GET = admin)
app.use('/api/realestate', realEstateRoutes); // cadastro de imobiliárias (CV)
app.use('/api/correspondents', correspondentRoutes); // correspondentes (CV)
app.use('/api/conditions', conditionsRoutes);
app.use('/api/event-plans', eventPlanRoutes); // Plano de Eventos (comercial)
app.use('/api/boleto-caixa', boletoRoutes);
app.use('/api/cancelamento-reservas', reservaCancelRoutes);
// Encurtador de URL público — rota fora de /api por elegância.
// Cliente que recebeu link curto via WhatsApp acessa `${host}/s/{slug}` e cai aqui.
app.use('/s', shortLinkRoutes);
app.use('/api/mcmv', mcmvRoutes);
app.use('/api/office-chat', officeChatRoutes);
app.use('/api/office-brain', officeBrainRoutes);
app.use('/api/reports', emeReportsRoutes); // Relatórios da Eme (builder admin + view interna)
app.use('/api/whatsapp-automations', whatsappAutomationRoutes);
app.use('/api/eme-atende/public', emeAtendePublicRoutes); // intake de leads (X-Api-Key)
app.use('/api/eme-atende', emeAtendeRoutes);              // admin (JWT + admin)
app.use('/api/academy-chat', academyChatRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/marketing', marketingRoutes);
app.use('/api/marketing-approvals', marketingApprovalRoutes);
app.use('/api/sales-stands', salesStandRoutes);
app.use('/api/sales-closings', salesClosingRoutes);
app.use('/api/bolao', bolaoRoutes);
app.use('/api/comunicados', comunicadoRoutes);
app.use('/api/checklists', checklistRoutes);
app.use('/api/organogram', organogramRoutes);
app.use('/api/docusign-oauth', docusignOauthRoutes); // callback público do login DocuSign (state assinado)

// Validador de integridade: registra o app para a varredura de rotas. A
// checagem de boot roda ao FINAL da fase de schema (ver initBackground) —
// rodar antes acusava falso "column does not exist" durante os ALTERs.
registerIntegrityApp(app);

const PORT = process.env.PORT || 5000;

// Timeout de segurança da fase de schema (em background). Se estourar, o
// servidor SEGUE NO AR — só loga. Override por env SCHEMA_PHASE_TIMEOUT_MS.
const SCHEMA_PHASE_TIMEOUT_MS = Number(process.env.SCHEMA_PHASE_TIMEOUT_MS) || 10 * 60 * 1000;

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`timeout de ${ms}ms na ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// ── Boot LISTEN-FIRST ───────────────────────────────────────────────────────
// O servidor abre a porta ANTES da fase pesada de schema. Assim um sync lento
// ou travado nunca mais derruba o servidor inteiro (incidente 2026-07-13): a
// fase de schema roda em segundo plano, com timeout. O único custo: numa
// janela de segundos logo após um deploy com mudança de schema, uma tela que
// dependa de coluna recém-criada pode hesitar até o sync terminar.
(async () => {
  // 1) Banco: fail-early — sem conexão não adianta subir.
  try {
    await db.sequelize.authenticate();
  } catch (err) {
    console.error('Erro ao conectar no banco:', err);
    return; // não escuta; Railway reinicia.
  }

  // 2) SOBE A PORTA JÁ — o site responde antes da fase de schema.
  app.listen(PORT, () => console.log(`Servidor rodando na porta: ${PORT}`));

  // 3) Fase de schema + serviços de background, DEPOIS do listen (não bloqueia).
  initBackground().catch(err => console.error('❌ init em background falhou:', err.message));
})();

async function initBackground() {
  try {
    await withTimeout(runSchemaPhase(), SCHEMA_PHASE_TIMEOUT_MS, 'fase de schema');
  } catch (err) {
    console.error('⚠️  Fase de schema falhou/estourou o tempo — o servidor SEGUE NO AR. '
      + 'Telas que dependem de schema recém-criado podem hesitar até resolver:', err.message);
  }
  // Schedulers + templates rodam de qualquer forma (operam em tabelas já existentes).
  await startBackgroundServices();

  // Checagem de integridade DEPOIS do schema estar em dia (resumo no log;
  // detalhe na tela /settings/integrity). Nunca derruba o boot.
  try {
    const r = await runIntegrityCheck();
    const flag = r.healthy ? '✅' : '🔴';
    console.log(`${flag} [Integrity] fail=${r.counts.fail || 0} warn=${r.counts.warn || 0} ok=${r.counts.ok || 0} — detalhe em /settings/integrity`);
    for (const c of r.checks.filter(c => c.status === 'fail')) {
      console.warn(`🔴 [Integrity] ${c.name}: ${c.summary}`);
    }
  } catch (e) {
    console.warn('⚠️  [Integrity] checagem de boot falhou:', e?.message);
  }
}

// Gate de schema: só roda a fase de sync/patches se algo que define schema
// mudou desde o último boot completo (fingerprint em lib/schemaSyncGate.js).
// FORCE_DB_SYNC=true força; SKIP_DB_SYNC=true pula sempre.
async function runSchemaPhase() {
  const gate = await shouldRunSchemaSync(db.sequelize);
  if (!gate.run) {
    console.log(`⚡ Fase de schema pulada (${gate.reason}) — FORCE_DB_SYNC=true para forçar.`);
    return;
  }

  console.log(`🔧 Fase de schema vai rodar (${gate.reason}) — em segundo plano.`);
  try {
    // Academy: dedup + drop UNIQUE antiga ANTES do sync, para que os models
    // novos possam recriar a UNIQUE correta sem conflito com dados/índices antigos.
    await ensureAcademyPreSync()
      .catch(err => console.warn('⚠️  Academy pre-sync falhou:', err.message));
    await db.sequelize.sync({ alter: false });
    console.log('Banco sincronizado com sucesso!');
    await syncModelsAndPatches(gate.fingerprint);
  } catch (err) {
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
      // Sync incompleto — sem fingerprint, pro próximo boot re-rodar a fase toda.
      await syncModelsAndPatches(null);
    } else {
      throw err; // capturado por initBackground — não derruba o servidor.
    }
  }
}

// Alters por model em evolução + patches ensure* + seeds + grava fingerprint.
// Roda em SEGUNDO PLANO (depois do listen), com timeout — ver runSchemaPhase.
async function syncModelsAndPatches(fingerprint) {
  // ⚠️ ADD COLUMN vem ANTES de tudo.
  //
  // Quando um model passa a declarar uma coluna nova, TODA query dele quebra
  // ("column X does not exist") até o ALTER rodar. Como esta fase roda depois
  // do listen, o app já está atendendo request nesse meio-tempo. Os patches que
  // só adicionam coluna custam milissegundos, então rodam primeiro e fecham
  // essa janela.
  const failedPatches = [];
  const runPatch = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      failedPatches.push(name);
      console.error(`❌ [SchemaPatch] ${name} falhou (os demais seguem):`, err?.message || err);
    }
  };

  await runPatch('ProjectionLink', ensureProjectionLinkSchema);     // cv_workflow_groups.stale_days
  await runPatch('FaturamentoRules', ensureFaturamentoRulesSchema); // stage_commission_rules.stage_id nullable
  await runPatch('SignupApprovalColumns', ensureSignupApprovalColumns); // users.approval_status + permission_profiles.department_id
  await runPatch('AccessModelColumns', ensureAccessModelColumns);   // users.position_id/city_id/permission_profile_id + user_permissions.routes_* + positions.level
  await runPatch('RoutePolicy', ensureRoutePolicySchema);           // route_policies + permission_profiles.seed_code/routes_customized
  await runPatch('EventPlan', ensureEventPlanSchema);               // event_plan_settings.auto_submit_enabled

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
    // Projeção de vendas — colunas custo_loja / blocked_considered_available (usadas pela projeção e por Gastos por Departamento)
    ['SalesProjectionEnterprise', db.SalesProjectionEnterprise],
    // Gastos por Departamento (ex-Viabilidade) — colunas de liberação novas em viability_enterprise_settings
    ['DeptSpendingEnterpriseSettings', db.DeptSpendingEnterpriseSettings],
    ['DeptSpendingMarketingDepartment', db.DeptSpendingMarketingDepartment],
    // Personalização de custos (categoria + observação) — Títulos/Custos agora ao vivo do backup
    ['ExpensePersonalization', db.ExpensePersonalization],
    // Eme Atende — atendente IA de leads (módulo novo em evolução)
    ['EmeAtendeSetting', db.EmeAtendeSetting],
    ['EmeAtendeApiKey', db.EmeAtendeApiKey],
    ['EmeAtendeFlow', db.EmeAtendeFlow],
    ['EmeAtendeFlowRule', db.EmeAtendeFlowRule],
    ['EmeAtendeLead', db.EmeAtendeLead],
    ['EmeAtendeConversation', db.EmeAtendeConversation],
    ['EmeAtendeMessage', db.EmeAtendeMessage],
    ['EmeAtendeEvent', db.EmeAtendeEvent],
    // Cancelamento de Reservas CV × Sienge (módulo novo em evolução)
    ['ReservaCancelSettings', db.ReservaCancelSettings],
    ['ReservaCancelHistory', db.ReservaCancelHistory],
    ['ReservaCancelEvent', db.ReservaCancelEvent],
    // Aprovações de Marketing (módulo novo em evolução)
    ['MarketingApprovalRequest', db.MarketingApprovalRequest],
    ['MarketingApprovalAuthProfile', db.MarketingApprovalAuthProfile],
    ['MarketingApprovalDecision', db.MarketingApprovalDecision],
    ['MarketingApprovalAttachment', db.MarketingApprovalAttachment],
    ['MarketingApprovalWaMessage', db.MarketingApprovalWaMessage],
    ['MarketingApprovalSettings', db.MarketingApprovalSettings],
    // Stand de Vendas (módulo novo em evolução)
    ['SalesStandModel', db.SalesStandModel],
    ['SalesStand', db.SalesStand],
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
  //
  // Cada patch roda ISOLADO: antes eram `await` encadeados e o primeiro que
  // lançasse abortava todos os seguintes, deixando o schema pela metade sem
  // nenhum aviso claro (o sintoma aparecia depois, como "column X does not
  // exist" numa tela qualquer). Um patch quebrado não pode derrubar os outros.
  const patches = [
    ['FinanceOverrides', ensureFinanceOverridesSchema],
    ['SiengeBackupLog', ensureSiengeBackupLogSchema],
    ['Boleto', ensureBoletoSchema],
    ['ReservaCancel', ensureReservaCancelSchema],
    ['AcademyPostSync', ensureAcademyPostSync],
    ['MarketingCapture', ensureMarketingCaptureSchema],
    ['EmeBrain', ensureEmeBrainSchema],
    ['EmeReports', ensureEmeReportsSchema],
    ['WhatsappAutomation', ensureWhatsappAutomationSchema],
    ['WhatsappMessages', ensureWhatsappMessagesSchema],
    ['EmeAtendeSeed', ensureEmeAtendeSeed],
    ['AlertShares', ensureAlertSharesSchema],
    ['DeptSpending', ensureDeptSpendingSchema],
    ['DepartmentVisibility', ensureDepartmentVisibilitySchema],
    ['ComercialConditions', ensureComercialConditionsSchema],
    ['Organogram', ensureOrganogramSchema],
    ['EmeAudit', ensureEmeAuditSchema],
    ['PermissionRouteRenames', ensurePermissionRouteRenames],
    ['InitialTypes', seedInitialTypes],
    ['SalesStandModels', seedSalesStandModels],
    ['Checklist', ensureChecklistSchema],
    ['LegacyDrops', ensureLegacyDrops],
    ['AccessModel', ensureAccessModelSchema],
    // Catálogo de cidades (IBGE) ANTES do OrgDefaults: o backfill de
    // users.city_id casa por nome e precisa das cidades já no lugar.
    ['BrazilCities', ensureBrazilCitiesSeed],
    ['OrgDefaults', ensureOrgDefaultsSchema],
    // Perfis padrão DEPOIS do OrgDefaults: o seed cria um perfil por
    // departamento e precisa dos departamentos padrão já no banco (antes,
    // departamento novo só ganhava perfil no boot seguinte).
    ['DepartmentDefaultProfiles', seedDepartmentDefaultProfiles],
  ];

  for (const [name, fn] of patches) {
    await runPatch(name, fn);
  }

  seedChecklist().catch(err => console.warn('⚠️  seedChecklist falhou:', err?.message || err)); // background: não bloqueia o boot

  // Com o schema aplicado, confere se sobrou algum model declarando coluna que o
  // banco não tem. Só reclama no log — mas reclama com nome e sobrenome, para o
  // erro não reaparecer depois disfarçado de falha genérica numa tela.
  await schemaDriftCheck();

  // Fingerprint só quando TUDO passou. Com algum patch quebrado, o próximo boot
  // tenta de novo em vez de pular a fase achando que o schema está em dia.
  if (failedPatches.length) {
    console.error(`❌ [SchemaPatch] ${failedPatches.length} patch(es) falharam: ${failedPatches.join(', ')}. Fingerprint NÃO gravado — a fase roda de novo no próximo boot.`);
    return;
  }
  await recordSchemaSync(db.sequelize, fingerprint);
}

// WhatsApp templates + schedulers. Roda depois do listen (não bloqueia o boot).
// Opera só em tabelas já existentes, então roda mesmo se a fase de schema falhar.
async function startBackgroundServices() {
  // Provisiona template WhatsApp do boleto na Meta se faltar — assim em caso
  // de perda/recriação da conta Meta o sistema se auto-recupera. Idempotente.
  ensureBoletoWhatsappTemplate().catch(err =>
      console.warn('⚠️  ensureBoletoWhatsappTemplate falhou:', err.message));
  ensureChecklistWhatsappTemplates().catch(err =>
      console.warn('⚠️  ensureChecklistWhatsappTemplates falhou:', err.message));
  ensureMarketingApprovalWhatsappTemplates().catch(err =>
      console.warn('⚠️  ensureMarketingApprovalWhatsappTemplates falhou:', err.message));

  // ── Gate de schedulers ────────────────────────────────────────────────────
  // Produção: cada cron mantém o comportamento histórico. DEV (local): NENHUM
  // cron inicia por padrão — evita rodar automação contra CV/Meta/Supabase/
  // notificações de PRODUÇÃO a partir da máquina local. Para ligar um específico
  // em dev, defina a env ENABLE_* correspondente = 'true' no .env.
  const IS_PROD = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const schedulerOn = (envVar, onByDefaultInProd = true) => {
    const v = process.env[envVar];
    if (v === 'true') return true;      // opt-in explícito (vale inclusive em dev)
    if (v === 'false') return false;    // opt-out explícito (vale inclusive em prod)
    return IS_PROD && onByDefaultInProd; // sem flag: comportamento histórico só em produção
  };

  // Crons opt-in (já eram OFF por padrão em qualquer ambiente):
  if (process.env.ENABLE_CONTRACT_SCHEDULE === 'true') contractValidatorScheduler.start();
  if (process.env.ENABLE_SIENGE_CONTRACT_SCHEDULE === 'true') contractSiengeScheduler.start();
  // Vigilância dos meses consolidados acompanha o sync de contratos: se os
  // contratos sincronizam, os fechamentos precisam ser conferidos.
  if (process.env.ENABLE_SIENGE_CONTRACT_SCHEDULE === 'true') salesClosingScheduler.start();
  if (process.env.ENABLE_CV_LEAD_SCHEDULE === 'true') leadCvScheduler.start();
  if (process.env.ENABLE_CV_REPASSE_SCHEDULE === 'true') repasseCvScheduler.start();
  if (process.env.ENABLE_CV_RESERVA_SCHEDULE === 'true') reservaCvScheduler.start();
  if (process.env.ENABLE_CV_RESERVA_SWEEP_SCHEDULE === 'true') reservaCvSweepScheduler.start();
  // Gap-fill de reservas: acompanha o delta. A listagem do CV não devolve tudo,
  // e sem isto o banco fica com furos permanentes na sequência de idreserva
  // (reservas que existem no CV e nunca chegam à projeção). Roda junto do delta
  // porque é o complemento dele; desligue com ENABLE_CV_RESERVA_GAP=false.
  if (process.env.ENABLE_CV_RESERVA_SCHEDULE === 'true' && process.env.ENABLE_CV_RESERVA_GAP !== 'false') {
    reservaCvGapScheduler.start();
  }
  if (process.env.ENABLE_LAND_CONTRACT_SCHEDULE === 'true') landScheduler.start();
  if (process.env.ENABLE_CV_ENTERPRISE_SCHEDULE === 'true') enterpriseCvScheduler.start();
  // Registro unificado de empresas/empreendimentos: sync diário de madrugada
  // (sempre ligado — dispensa o sync manual; ORG_REGISTRY_CRON_EXPRESSION p/ ajustar).
  orgRegistryScheduler.start();
  if (process.env.ENABLE_CV_PRECADASTRO_SCHEDULE === 'true') precadastroCvScheduler.start();
  if (process.env.ENABLE_CV_LEAD_SCHEDULE === 'true') leadCancelReasonScheduler.start();
  if (process.env.ENABLE_SIENGE_BACKUP_SCHEDULE === 'true') siengeBackupScheduler.start();

  // Índices de performance no backup do Sienge (Custos/Títulos ao vivo). O restore
  // diário já os reaplica; este ensure cobre deploy feito DEPOIS do restore do dia.
  // Deferido e fire-and-forget: não bloqueia o boot; CREATE INDEX IF NOT EXISTS é
  // no-op quando já existem.
  if (schedulerOn('ENABLE_SIENGE_PERF_INDEXES')) {
    setTimeout(() => {
      import('./services/sienge/SiengeBackupService.js')
        .then(m => m.ensurePerfIndexes())
        .then(r => console.log('[BOOT] sienge perf indexes:', JSON.stringify(r)))
        .catch(err => console.warn('⚠️  ensurePerfIndexes falhou (segue sem índices extras):', err.message));
    }, 30_000);
  }

  // Crons que antes ligavam sempre / por padrão — agora gated (prod = igual, dev = off):
  if (schedulerOn('ENABLE_CREDITOR_POLLING')) creditorPollingScheduler.start();
  if (schedulerOn('ENABLE_CONTRACT_APPROVAL')) contractApprovalScheduler.start();
  if (schedulerOn('ENABLE_SUPABASE_KEEPALIVE')) supabaseKeepAliveScheduler.start();
  if (schedulerOn('ENABLE_CV_EXTRAS_SCHEDULE')) cvExtrasScheduler.start(); // extras do CV
  if (schedulerOn('ENABLE_CV_CORRESPONDENT_SCHEDULE')) correspondentCvScheduler.start(); // espelho de correspondentes + empresas
  if (schedulerOn('ENABLE_CONDITION_AUTOGEN')) conditionAutoGenerateScheduler.start(); // auto-geração mensal de fichas (com e sem CV)
  if (schedulerOn('ENABLE_EVENT_PLAN_CYCLE')) eventPlanCycleScheduler.start(); // Plano de Eventos: abre o mês seguinte + cobra o prazo
  if (schedulerOn('ENABLE_BOLETO_CLEANUP')) boletoCleanupScheduler.start(); // remove boletos expirados do Supabase
  if (schedulerOn('ENABLE_BOLETO_PAYMENT_CHECK_IN_DEV')) boletoPaymentCheckScheduler.start(); // 8h: verifica pagamento/baixa (já self-skip em dev)
  if (schedulerOn('ENABLE_BOLETO_SITUACAO_APPLY')) boletoSituacaoApplyScheduler.start(); // 1min: aplica situações CV agendadas (delay lote Sienge)
  if (schedulerOn('ENABLE_EVENT_REMINDER')) eventReminderScheduler.start(); // lembretes de evento (D-1) via NotificationService
  if (schedulerOn('ENABLE_REPORT_PUBLIC_EXPIRY')) reportPublicExpiryScheduler.start(); // links públicos de relatórios: aviso D-3 + revoga vencidos (08:00)
  if (schedulerOn('ENABLE_ACADEMY_DEADLINE')) startAcademyDeadlineScheduler(); // lembretes de trilhas obrigatórias (D-3/D-1/D0/OVERDUE)
  if (schedulerOn('ENABLE_ACADEMY_RECERTIFY')) startAcademyRecertifyScheduler(); // recertificação periódica (expira certificado + reassign mandatory)
  if (schedulerOn('ENABLE_ACADEMY_ONBOARDING')) startAcademyOnboardingScheduler(); // aplica regras de onboarding (auto-atribui trilhas)
  if (schedulerOn('ENABLE_ACADEMY_DIGEST')) academyDigestScheduler.start(); // mantém digests/embeddings da KB da Eme em dia (03:30)
  if (schedulerOn('ENABLE_MARKETING_CAPTURE')) marketingDispatchScheduler.start(); // re-tenta despacho de leads ao CV
  if (schedulerOn('ENABLE_MARKETING_AUTO_SYNC')) marketingSyncScheduler.start(); // sync Meta (forms/campanhas/ads/leads) — full a cada 2h em horário comercial + light 15/15min
  if (schedulerOn('ENABLE_BOLAO_LIVE')) bolaoLiveScheduler.start(); // placar ao vivo do bolão (poll ESPN na janela do jogo)
  if (process.env.SEED_BOLAO_COPA === 'true') {
    seedBolaoCopa2026().catch(err => console.warn('⚠️  seedBolaoCopa2026 falhou:', err.message));
  }
  if (process.env.SEED_BOLAO_PUBLICO === 'true') {
    seedBolaoPublico().catch(err => console.warn('⚠️  seedBolaoPublico falhou:', err.message));
  }
  if (process.env.SEED_BOLAO_JAPAO === 'true') {
    seedBolaoJapao().catch(err => console.warn('⚠️  seedBolaoJapao falhou:', err.message));
  }
  if (schedulerOn('ENABLE_ALERT_ENGINE')) await AlertEngine.boot(); // registra crons das alert_rules salvas
  if (!IS_PROD) {
    console.log('[BOOT] DEV: schedulers desligados por padrão. Ligue um específico com ENABLE_*=true no .env.');
  }
}

//   | Ambiente        | Método recomendado            | Observações                             |
// | --------------- | ----------------------------- | --------------------------------------- |
// | Desenvolvimento | `sync({ force: true })`       | Recria do zero sempre, útil para testar |
// | Desenvolvimento | `sync({ alter: true })`       | Adapta estrutura sem perder dados       |
// | Produção        | `sync()` ou migrações via CLI | Use migrações para controle total       |

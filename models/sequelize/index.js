// /models/sequelize/index.js
import { Sequelize, DataTypes } from 'sequelize';
import dotenv from 'dotenv';
dotenv.config();
import UserDefine from './user.js';
import PositionDefine from './position.js';
import UserCityDefine from './userCity.js';
import DepartmentDefine from './department.js';
import DepartmentCategoryDefine from './departmentCategory.js';
import FavoriteDefine from './favorite.js';
import EventDefine from './event.js';
import config from '../../config/config.cjs';
import TokenUsageDefine from './tokenUsage.js';
import ValidationHistoryDefine from './validationHistory.js';

// Singe imports
import SalesContractDefine from './sienge/salesContract.js';
import SiengeBillDefine from './sienge/bill.js';
import SiengeBillInstallmentDefine from './sienge/billInstallment.js';

import ExpenseDefine from './expense.js';
import CostCenterOverrideDefine from './costCenterOverride.js';
import ExpenseDepartmentVisibilityDefine from './expenseDepartmentVisibility.js';

// perto dos outros imports
import LeadDefine from './cv/lead.js';
// ...
import RepasseDefine from './cv/repasse.js';
// ...
import ReservaDefine from './cv/reserva.js';
// 👇 IMPORTES NOVOS
import SupportMessageDefine from './supportMessage.js';
import SupportTicketDefine from './supportTicket.js';

import EnterpriseCityDefine from './enterpriseCity.js';

import SalesProjectionDefine from './projection/salesProjection.js';
import SalesProjectionLineDefine from './projection/salesProjectionLine.js';
import SalesProjectionLogDefine from './projection/salesProjectionLog.js';
import SalesProjectionEnterpriseDefine from './projection/salesProjectionEnterprise.js';

// ... imports existentes
import CvEnterpriseDefine from './cv/enterprise.js';
import CvEnterpriseStageDefine from './cv/enterpriseStage.js';
import CvEnterpriseBlockDefine from './cv/enterpriseBlock.js';
import CvEnterpriseUnitDefine from './cv/enterpriseUnit.js';
import CvEnterpriseMaterialDefine from './cv/enterpriseMaterial.js';
import CvEnterprisePlanDefine from './cv/enterprisePlan.js';

import CvWorkflowGroupDefine from './cv/workflowGroup.js';

import landSyncEnterpriseDefine from './landSyncEnterprise.js';
import hiddenDashboardEnterpriseDefine from './hiddenDashboardEnterprise.js';
import stageCommissionRuleDefine from './stageCommissionRule.js';
import trSatelliteEnterpriseDefine from './trSatelliteEnterprise.js';

import SiengeAwardDefine from './sienge/award.js';
import SiengeAwardLinkDefine from './sienge/awardLink.js';
import SiengeAwardLogDefine from './sienge/awardLog.js';
import PaymentLaunchDefine from './sienge/paymentLaunch.js';
import LaunchTypeConfigDefine from './sienge/launchTypeConfig.js';
import SiengeBackupLogDefine from './sienge/backupLog.js';
import BillsSyncLogDefine from './sienge/billsSyncLog.js';
import BillsAutoSyncSubscriptionDefine from './sienge/billsAutoSyncSubscription.js';

import AcademyArticleDefine from './academy/article.js';
import AcademyTopicDefine from './academy/topic.js';
import AcademyUserTrackProgressDefine from './academy/userTrackProgress.js';
import AcademyHighlightDefine from './academy/highlight.js';
import AcademyPostDefine from './academy/post.js';
import AcademyTrackDefine from './academy/track.js';
import AcademyTrackItemDefine from './academy/trackItem.js';
import AcademyUserProgressDefine from './academy/userProgress.js';
import AcademyTrackAssignmentDefine from './academy/trackAssignment.js';
import AcademyUserQuizAttemptDefine from './academy/userQuizAttempt.js';
import AcademyPostUpvoteDefine from './academy/postUpvote.js';
import AcademyCertificateDefine from './academy/certificate.js';
import AcademyModuleDefine from './academy/module.js';
import AcademyQuestionDefine from './academy/question.js';
import AcademyQuizQuestionDefine from './academy/quizQuestion.js';
import AcademyArticleVersionDefine from './academy/articleVersion.js';
import AcademyTrackPrerequisiteDefine from './academy/trackPrerequisite.js';
import AcademyFollowDefine from './academy/follow.js';
import AcademyArticleCommentDefine from './academy/articleComment.js';
import AcademyRatingDefine from './academy/rating.js';
import AcademyUserXpDefine from './academy/userXp.js';
import AcademyXpLogDefine from './academy/xpLog.js';
import AcademyBadgeDefine from './academy/badge.js';
import AcademyUserBadgeDefine from './academy/userBadge.js';
import AcademyVideoWatchDefine from './academy/videoWatch.js';
import AcademyOnboardingRuleDefine from './academy/onboardingRule.js';
import EmeAuditLogDefine from './emeAuditLog.js';

import ExternalOrganizationDefine from './academy/external/externalOrganization.js';
import AuthAccessCodeDefine from './academy/external/authAccessCode.js';

import MeetingTranscriptDefine from './meetingTranscript.js';
import InPersonMeetingDefine from './inPersonMeeting.js';
import BucketUploadHistoryDefine from './tools/bucketUploadHistory.js';
import UserPermissionDefine from './userPermission.js';
import PermissionProfileDefine from './permissionProfile.js';
import SignatureDefine from './signature.js';
import SignatureDocumentDefine from './signatureDocument.js';
import SignatureDocumentSignerDefine from './signatureDocumentSigner.js';

// CV extras
import CvEnterprisePriceTableDefine from './cv/enterprisePriceTable.js';
import CvCorrespondentDefine from './cv/cvCorrespondent.js';
import CvPrecadastroDefine from './cv/cvPrecadastro.js';
import CvSyncStateDefine from './cv/cvSyncState.js';
import CvReservaIdDeadDefine from './cv/cvReservaIdDead.js';

// Fichas Comerciais
import EnterpriseConditionDefine from './comercial/enterpriseCondition.js';
import EnterpriseConditionModuleDefine from './comercial/enterpriseConditionModule.js';
import EnterpriseConditionCampaignDefine from './comercial/enterpriseConditionCampaign.js';
import ComercialSettingsDefine from './comercial/comercialSettings.js';
import McmvMunicipioDefine from './comercial/mcmvMunicipio.js';
import McmvImportLogDefine from './comercial/mcmvImportLog.js';

// Boleto Caixa
import BoletoSettingsDefine from './boleto/boletoSettings.js';
import BoletoHistoryDefine from './boleto/boletoHistory.js';
import BoletoComissionRuleDefine from './boleto/boletoComissionRule.js';

// OfficeAI Chat
import ChatSessionDefine from './chatSession.js';
import ChatMessageDefine from './chatMessage.js';
import UserAIMemoryDefine from './userAIMemory.js';
import ChatFeedbackDefine from './chatFeedback.js';

// Notificações
import NotificationDefine from './notification.js';
import NotificationPreferenceDefine from './notificationPreference.js';

// WhatsApp Business
import WhatsappConfigDefine from './whatsapp/whatsappConfig.js';
import WhatsappTemplateDefine from './whatsapp/whatsappTemplate.js';
import WhatsappMessageDefine from './whatsapp/whatsappMessage.js';

// Alertas (gerenciados via Eme AI)
import AlertRuleDefine         from './alerts/alertRule.js';
import AlertTriggerLogDefine   from './alerts/alertTriggerLog.js';
import AlertPendingReplyDefine from './alerts/alertPendingReply.js';

// Marketing — Captação de Leads
import InboundLeadDefine      from './marketing/inboundLead.js';
import InboundLeadEventDefine from './marketing/inboundLeadEvent.js';
import LeadFormDefine         from './marketing/leadForm.js';
import MarketingConfigDefine  from './marketing/marketingConfig.js';
import MetaLeadFormDefine     from './marketing/metaLeadForm.js';
import MetaCampaignDefine     from './marketing/metaCampaign.js';
import MetaAdDefine           from './marketing/metaAd.js';

const env = process.env.NODE_ENV || 'development';

const cfg = config[env];
const sequelize = new Sequelize(cfg.database, cfg.username, cfg.password, {
  host: cfg.host, port: cfg.port, dialect: cfg.dialect,
  define: cfg.define, pool: cfg.pool, logging: false
});

const db = {};
db.User = UserDefine(sequelize, DataTypes);
db.Position = PositionDefine(sequelize, DataTypes);
db.UserCity = UserCityDefine(sequelize, DataTypes);
db.Department = DepartmentDefine(sequelize, DataTypes);
db.DepartmentCategory = DepartmentCategoryDefine(sequelize, DataTypes);
db.Favorite = FavoriteDefine(sequelize, DataTypes);
db.Event = EventDefine(sequelize, DataTypes);
db.TokenUsage = TokenUsageDefine(sequelize, DataTypes);
db.ValidationHistory = ValidationHistoryDefine(sequelize, DataTypes);

// sienge db 
db.SalesContract = SalesContractDefine(sequelize, DataTypes);
db.SiengeBill = SiengeBillDefine(sequelize, DataTypes);
db.SiengeBillInstallment = SiengeBillInstallmentDefine(sequelize, DataTypes);

db.Expense = ExpenseDefine(sequelize, DataTypes);
db.CostCenterOverride = CostCenterOverrideDefine(sequelize, DataTypes);
db.ExpenseDepartmentVisibility = ExpenseDepartmentVisibilityDefine(sequelize, DataTypes);

// ... após definir outros modelos:
db.Lead = LeadDefine(sequelize, DataTypes);

db.Repasse = RepasseDefine(sequelize, DataTypes);
// ...
db.Reserva = ReservaDefine(sequelize, DataTypes);

// 👇 REGISTRE AQUI OS NOVOS MODELOS
db.SupportTicket = SupportTicketDefine(sequelize, DataTypes);
db.SupportMessage = SupportMessageDefine(sequelize, DataTypes);

db.EnterpriseCity = EnterpriseCityDefine(sequelize, DataTypes);

db.SalesProjection = SalesProjectionDefine(sequelize, DataTypes);
db.SalesProjectionLine = SalesProjectionLineDefine(sequelize, DataTypes);
db.SalesProjectionLog = SalesProjectionLogDefine(sequelize, DataTypes);
db.SalesProjectionEnterprise = SalesProjectionEnterpriseDefine(sequelize, DataTypes);

// ... modelos já existentes
db.CvEnterprise = CvEnterpriseDefine(sequelize, DataTypes);
db.CvEnterpriseStage = CvEnterpriseStageDefine(sequelize, DataTypes);
db.CvEnterpriseBlock = CvEnterpriseBlockDefine(sequelize, DataTypes);
db.CvEnterpriseUnit = CvEnterpriseUnitDefine(sequelize, DataTypes);
db.CvEnterpriseMaterial = CvEnterpriseMaterialDefine(sequelize, DataTypes);
db.CvEnterprisePlan = CvEnterprisePlanDefine(sequelize, DataTypes);

db.CvWorkflowGroup = CvWorkflowGroupDefine(sequelize, DataTypes);

db.LandSyncEnterprise = landSyncEnterpriseDefine(sequelize, DataTypes);
db.HiddenDashboardEnterprise = hiddenDashboardEnterpriseDefine(sequelize, DataTypes);
db.StageCommissionRule = stageCommissionRuleDefine(sequelize, DataTypes);
db.TrSatelliteEnterprise = trSatelliteEnterpriseDefine(sequelize, DataTypes);

db.Award = SiengeAwardDefine(sequelize, DataTypes);
db.AwardLink = SiengeAwardLinkDefine(sequelize, DataTypes);
db.AwardLog = SiengeAwardLogDefine(sequelize, DataTypes);
db.PaymentLaunch = PaymentLaunchDefine(sequelize, DataTypes);
db.LaunchTypeConfig = LaunchTypeConfigDefine(sequelize, DataTypes);
db.SiengeBackupLog = SiengeBackupLogDefine(sequelize, DataTypes);
db.BillsSyncLog                = BillsSyncLogDefine(sequelize, DataTypes);
db.BillsAutoSyncSubscription   = BillsAutoSyncSubscriptionDefine(sequelize, DataTypes);

db.AcademyArticle = AcademyArticleDefine(sequelize, DataTypes);
db.AcademyTopic = AcademyTopicDefine(sequelize, DataTypes);
db.AcademyUserTrackProgress = AcademyUserTrackProgressDefine(sequelize, DataTypes);
db.AcademyHighlight = AcademyHighlightDefine(sequelize, DataTypes);
db.AcademyPost = AcademyPostDefine(sequelize, DataTypes);
db.AcademyTrack = AcademyTrackDefine(sequelize, DataTypes);
db.AcademyTrackItem = AcademyTrackItemDefine(sequelize, DataTypes);
db.AcademyUserProgress = AcademyUserProgressDefine(sequelize, DataTypes);
db.AcademyTrackAssignment = AcademyTrackAssignmentDefine(sequelize, DataTypes);
db.AcademyUserQuizAttempt = AcademyUserQuizAttemptDefine(sequelize, DataTypes);
db.AcademyPostUpvote = AcademyPostUpvoteDefine(sequelize, DataTypes);
db.AcademyCertificate = AcademyCertificateDefine(sequelize, DataTypes);
db.AcademyModule = AcademyModuleDefine(sequelize, DataTypes);
db.AcademyQuestion = AcademyQuestionDefine(sequelize, DataTypes);
db.AcademyQuizQuestion = AcademyQuizQuestionDefine(sequelize, DataTypes);
db.AcademyArticleVersion = AcademyArticleVersionDefine(sequelize, DataTypes);
db.AcademyTrackPrerequisite = AcademyTrackPrerequisiteDefine(sequelize, DataTypes);
db.AcademyFollow = AcademyFollowDefine(sequelize, DataTypes);
db.AcademyArticleComment = AcademyArticleCommentDefine(sequelize, DataTypes);
db.AcademyRating = AcademyRatingDefine(sequelize, DataTypes);
db.AcademyUserXp = AcademyUserXpDefine(sequelize, DataTypes);
db.AcademyXpLog = AcademyXpLogDefine(sequelize, DataTypes);
db.AcademyBadge = AcademyBadgeDefine(sequelize, DataTypes);
db.AcademyUserBadge = AcademyUserBadgeDefine(sequelize, DataTypes);
db.AcademyVideoWatch = AcademyVideoWatchDefine(sequelize, DataTypes);
db.AcademyOnboardingRule = AcademyOnboardingRuleDefine(sequelize, DataTypes);
db.EmeAuditLog = EmeAuditLogDefine(sequelize, DataTypes);

db.ExternalOrganization = ExternalOrganizationDefine(sequelize, DataTypes);
db.AuthAccessCode = AuthAccessCodeDefine(sequelize, DataTypes);

db.MeetingTranscript = MeetingTranscriptDefine(sequelize, DataTypes);
db.InPersonMeeting   = InPersonMeetingDefine(sequelize, DataTypes);
db.BucketUploadHistory = BucketUploadHistoryDefine(sequelize, DataTypes);
db.UserPermission = UserPermissionDefine(sequelize, DataTypes);
db.PermissionProfile = PermissionProfileDefine(sequelize, DataTypes);
db.Signature = SignatureDefine(sequelize, DataTypes);
db.SignatureDocument       = SignatureDocumentDefine(sequelize, DataTypes);
db.SignatureDocumentSigner = SignatureDocumentSignerDefine(sequelize, DataTypes);

// CV extras
db.CvEnterprisePriceTable = CvEnterprisePriceTableDefine(sequelize, DataTypes);
db.CvCorrespondent        = CvCorrespondentDefine(sequelize, DataTypes);
db.CvPrecadastro          = CvPrecadastroDefine(sequelize, DataTypes);
db.CvSyncState            = CvSyncStateDefine(sequelize, DataTypes);
db.CvReservaIdDead        = CvReservaIdDeadDefine(sequelize, DataTypes);

// Fichas Comerciais
db.EnterpriseCondition         = EnterpriseConditionDefine(sequelize, DataTypes);
db.EnterpriseConditionModule   = EnterpriseConditionModuleDefine(sequelize, DataTypes);
db.EnterpriseConditionCampaign = EnterpriseConditionCampaignDefine(sequelize, DataTypes);
db.ComercialSettings           = ComercialSettingsDefine(sequelize, DataTypes);
db.McmvMunicipio               = McmvMunicipioDefine(sequelize, DataTypes);
db.McmvImportLog               = McmvImportLogDefine(sequelize, DataTypes);

// Boleto Caixa
db.BoletoSettings      = BoletoSettingsDefine(sequelize, DataTypes);
db.BoletoHistory       = BoletoHistoryDefine(sequelize, DataTypes);
db.BoletoComissionRule = BoletoComissionRuleDefine(sequelize, DataTypes);

// OfficeAI Chat
db.ChatSession  = ChatSessionDefine(sequelize, DataTypes);
db.ChatMessage  = ChatMessageDefine(sequelize, DataTypes);
db.UserAIMemory = UserAIMemoryDefine(sequelize, DataTypes);
db.ChatFeedback = ChatFeedbackDefine(sequelize, DataTypes);

// Notificações
db.Notification           = NotificationDefine(sequelize, DataTypes);
db.NotificationPreference = NotificationPreferenceDefine(sequelize, DataTypes);

// WhatsApp Business
db.WhatsappConfig   = WhatsappConfigDefine(sequelize, DataTypes);
db.WhatsappTemplate = WhatsappTemplateDefine(sequelize, DataTypes);
db.WhatsappMessage  = WhatsappMessageDefine(sequelize, DataTypes);

// Alertas
db.AlertRule         = AlertRuleDefine(sequelize, DataTypes);
db.AlertTriggerLog   = AlertTriggerLogDefine(sequelize, DataTypes);
db.AlertPendingReply = AlertPendingReplyDefine(sequelize, DataTypes);

// Marketing — Captação de Leads
db.InboundLead      = InboundLeadDefine(sequelize, DataTypes);
db.InboundLeadEvent = InboundLeadEventDefine(sequelize, DataTypes);
db.LeadForm         = LeadFormDefine(sequelize, DataTypes);
db.MarketingConfig  = MarketingConfigDefine(sequelize, DataTypes);
db.MetaLeadForm     = MetaLeadFormDefine(sequelize, DataTypes);
db.MetaCampaign     = MetaCampaignDefine(sequelize, DataTypes);
db.MetaAd           = MetaAdDefine(sequelize, DataTypes);

// Se tiver associações, faça-as aqui:
Object.values(db)
  .filter(m => typeof m.associate === 'function')
  .forEach(m => m.associate(db));

db.sequelize = sequelize;
db.Sequelize = Sequelize;
export default db;

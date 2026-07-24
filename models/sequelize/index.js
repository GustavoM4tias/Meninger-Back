// /models/sequelize/index.js
import { Sequelize, DataTypes } from 'sequelize';
import dotenv from 'dotenv';
dotenv.config();
import UserDefine from './user.js';
import RefreshTokenDefine from './refreshToken.js';
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
import ExpensePersonalizationDefine from './sienge/expensePersonalization.js';

import CostCenterOverrideDefine from './costCenterOverride.js';
import ExpenseDepartmentVisibilityDefine from './expenseDepartmentVisibility.js';
import DepartmentVisibilityOverrideDefine from './departmentVisibilityOverride.js';
import OrganogramOverrideDefine from './organogramOverride.js';

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

// Gastos por Departamento — config admin + liberação (ex-Viabilidade)
import DeptSpendingMarketingDepartmentDefine from './deptSpending/marketingDepartment.js';
import DeptSpendingEnterpriseSettingsDefine from './deptSpending/enterpriseSettings.js';

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

import PaymentLaunchDefine from './sienge/paymentLaunch.js';
import LaunchTypeConfigDefine from './sienge/launchTypeConfig.js';
import SiengeBackupLogDefine from './sienge/backupLog.js';

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
import ReportExportLogDefine from './reportExportLog.js';

import ExternalOrganizationDefine from './academy/external/externalOrganization.js';
import AuthAccessCodeDefine from './academy/external/authAccessCode.js';

import MeetingTranscriptDefine from './meetingTranscript.js';
import InPersonMeetingDefine from './inPersonMeeting.js';
import InstantMeetingDefine from './instantMeeting.js';
import BucketUploadHistoryDefine from './tools/bucketUploadHistory.js';
import UserPermissionDefine from './userPermission.js';
import PermissionProfileDefine from './permissionProfile.js';

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
import CampaignTemplateDefine from './comercial/campaignTemplate.js';
import DocusignSettingsDefine from './comercial/docusignSettings.js';
import ConditionSignatureDefine from './comercial/conditionSignature.js';
import McmvMunicipioDefine from './comercial/mcmvMunicipio.js';
import McmvImportLogDefine from './comercial/mcmvImportLog.js';

// Boleto Caixa
import BoletoSettingsDefine from './boleto/boletoSettings.js';
import BoletoHistoryDefine from './boleto/boletoHistory.js';
import BoletoComissionRuleDefine from './boleto/boletoComissionRule.js';
import BoletoEventDefine from './boleto/boletoEvent.js';
import BoletoEcoLockDefine from './boleto/boletoEcoLock.js';

// Cancelamento de Reservas (CV × Sienge)
import ReservaCancelSettingsDefine from './reservaCancel/reservaCancelSettings.js';
import ReservaCancelHistoryDefine from './reservaCancel/reservaCancelHistory.js';
import ReservaCancelEventDefine from './reservaCancel/reservaCancelEvent.js';

// Encurtador de URL genérico
import ShortLinkDefine from './shortLink.js';

// OfficeAI Chat
import ChatSessionDefine from './chatSession.js';
import ChatMessageDefine from './chatMessage.js';
import UserAIMemoryDefine from './userAIMemory.js';
import ChatFeedbackDefine from './chatFeedback.js';

// Cérebro da Eme (Brain Studio) — config DB-driven do assistente
import EmePromptBlockDefine   from './eme/promptBlock.js';
import EmeGlossaryTermDefine  from './eme/glossaryTerm.js';
import EmeReportDefine        from './eme/report.js';
import EmeSettingDefine       from './eme/setting.js';
import EmeConfigVersionDefine from './eme/configVersion.js';

// Relatórios da Eme — relatórios customizados gerados por IA (eme_generated_*)
import EmeGeneratedReportDefine            from './emeReports/generatedReport.js';
import EmeGeneratedReportVersionDefine     from './emeReports/generatedReportVersion.js';
import EmeGeneratedReportMessageDefine     from './emeReports/generatedReportMessage.js';
import EmeGeneratedReportAccessDefine      from './emeReports/generatedReportAccess.js';
import EmeGeneratedReportPublicLogDefine   from './emeReports/generatedReportPublicLog.js';
import EmeGeneratedReportCustomBlockDefine from './emeReports/generatedReportCustomBlock.js';
import EmeGeneratedReportMemoryDefine      from './emeReports/generatedReportMemory.js';
import EmeGeneratedReportDismissalDefine   from './emeReports/generatedReportDismissal.js';

// Notificações
import NotificationDefine from './notification.js';
import NotificationPreferenceDefine from './notificationPreference.js';

// WhatsApp Business
import WhatsappConfigDefine from './whatsapp/whatsappConfig.js';
import WhatsappTemplateDefine from './whatsapp/whatsappTemplate.js';
import WhatsappMessageDefine from './whatsapp/whatsappMessage.js';
import WhatsappAutomationDefine from './whatsapp/whatsappAutomation.js';
import WhatsappAutomationRunDefine from './whatsapp/whatsappAutomationRun.js';

// Meta — credenciais de App compartilhadas (WhatsApp + Lead Ads)
import MetaAppConfigDefine from './meta/metaAppConfig.js';

// Eme Atende — atendente IA de leads via WhatsApp
import EmeAtendeSettingDefine      from './emeAtende/emeAtendeSetting.js';
import EmeAtendeApiKeyDefine       from './emeAtende/emeAtendeApiKey.js';
import EmeAtendeFlowDefine         from './emeAtende/emeAtendeFlow.js';
import EmeAtendeFlowRuleDefine     from './emeAtende/emeAtendeFlowRule.js';
import EmeAtendeLeadDefine         from './emeAtende/emeAtendeLead.js';
import EmeAtendeConversationDefine from './emeAtende/emeAtendeConversation.js';
import EmeAtendeMessageDefine      from './emeAtende/emeAtendeMessage.js';
import EmeAtendeEventDefine        from './emeAtende/emeAtendeEvent.js';

// Alertas (gerenciados via Eme AI)
import AlertRuleDefine         from './alerts/alertRule.js';
import AlertTriggerLogDefine   from './alerts/alertTriggerLog.js';
import AlertPendingReplyDefine from './alerts/alertPendingReply.js';
import AlertShareDefine        from './alerts/alertShare.js';

// Marketing — Captação de Leads
import InboundLeadDefine      from './marketing/inboundLead.js';
import InboundLeadEventDefine from './marketing/inboundLeadEvent.js';
import LeadFormDefine         from './marketing/leadForm.js';
import MarketingConfigDefine  from './marketing/marketingConfig.js';
import MetaLeadFormDefine     from './marketing/metaLeadForm.js';
import MetaCampaignDefine     from './marketing/metaCampaign.js';
import MetaAdDefine           from './marketing/metaAd.js';
import MetaAdSetDefine        from './marketing/metaAdSet.js';
import MetaInsightDailyDefine from './marketing/metaInsightDaily.js';
import MarketingApprovalRequestDefine     from './marketing/marketingApprovalRequest.js';
import MarketingApprovalAuthProfileDefine from './marketing/marketingApprovalAuthProfile.js';
import MarketingApprovalDecisionDefine    from './marketing/marketingApprovalDecision.js';
import MarketingApprovalAttachmentDefine  from './marketing/marketingApprovalAttachment.js';
import MarketingApprovalWaMessageDefine   from './marketing/marketingApprovalWaMessage.js';
import MarketingApprovalSettingsDefine    from './marketing/marketingApprovalSettings.js';

// Bolão da Copa
import BolaoDefine            from './bolao/bolao.js';
import BolaoMatchDefine       from './bolao/bolaoMatch.js';
import BolaoParticipantDefine from './bolao/bolaoParticipant.js';
import BolaoPredictionDefine  from './bolao/bolaoPrediction.js';

// Mural de Avisos / Comunicados
import ComunicadoDefine           from './comunicados/comunicado.js';
import ComunicadoAssignmentDefine from './comunicados/comunicadoAssignment.js';
import ComunicadoReceiptDefine    from './comunicados/comunicadoReceipt.js';

// Checklist (gestão de lançamentos e demandas)
import ChecklistTemplateDefine        from './checklist/checklistTemplate.js';
import ChecklistTemplateSectionDefine from './checklist/checklistTemplateSection.js';
import ChecklistTemplateItemDefine    from './checklist/checklistTemplateItem.js';
import ChecklistDefine                from './checklist/checklist.js';
import ChecklistSectionDefine         from './checklist/checklistSection.js';
import ChecklistStatusDefine          from './checklist/checklistStatus.js';
import ChecklistTaskDefine            from './checklist/checklistTask.js';
import ChecklistTaskAttachmentDefine  from './checklist/checklistTaskAttachment.js';
import ChecklistTaskCommentDefine     from './checklist/checklistTaskComment.js';
import ChecklistActivityDefine        from './checklist/checklistActivity.js';
import ChecklistSettingsDefine        from './checklist/checklistSettings.js';
import ChecklistReminderRuleDefine    from './checklist/checklistReminderRule.js';
import ChecklistAuthProfileDefine     from './checklist/checklistAuthProfile.js';
import ChecklistTaskApprovalDefine    from './checklist/checklistTaskApproval.js';

// To Do (Microsoft) — índice local de enriquecimento das tarefas
import RealEstateRegistrationDefine from './realestate/registration.js';
import CvImobiliariaDefine from './cv/imobiliaria.js';
import TodoTaskRefDefine from './todo/todoTaskRef.js';

const env = process.env.NODE_ENV || 'development';

const cfg = config[env];
const sequelize = new Sequelize(cfg.database, cfg.username, cfg.password, {
  host: cfg.host, port: cfg.port, dialect: cfg.dialect,
  define: cfg.define, pool: cfg.pool, logging: false
});

const db = {};
db.User = UserDefine(sequelize, DataTypes);
db.RefreshToken = RefreshTokenDefine(sequelize, DataTypes);
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
db.ExpensePersonalization = ExpensePersonalizationDefine(sequelize, DataTypes);

db.CostCenterOverride = CostCenterOverrideDefine(sequelize, DataTypes);
db.ExpenseDepartmentVisibility = ExpenseDepartmentVisibilityDefine(sequelize, DataTypes);
db.DepartmentVisibilityOverride = DepartmentVisibilityOverrideDefine(sequelize, DataTypes);
db.OrganogramOverride = OrganogramOverrideDefine(sequelize, DataTypes);

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

// Gastos por Departamento — config admin + liberação (ex-Viabilidade)
db.DeptSpendingMarketingDepartment = DeptSpendingMarketingDepartmentDefine(sequelize, DataTypes);
db.DeptSpendingEnterpriseSettings = DeptSpendingEnterpriseSettingsDefine(sequelize, DataTypes);

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

db.PaymentLaunch = PaymentLaunchDefine(sequelize, DataTypes);
db.LaunchTypeConfig = LaunchTypeConfigDefine(sequelize, DataTypes);
db.SiengeBackupLog = SiengeBackupLogDefine(sequelize, DataTypes);

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
db.ReportExportLog = ReportExportLogDefine(sequelize, DataTypes);

db.ExternalOrganization = ExternalOrganizationDefine(sequelize, DataTypes);
db.AuthAccessCode = AuthAccessCodeDefine(sequelize, DataTypes);

db.MeetingTranscript = MeetingTranscriptDefine(sequelize, DataTypes);
db.InPersonMeeting   = InPersonMeetingDefine(sequelize, DataTypes);
db.InstantMeeting    = InstantMeetingDefine(sequelize, DataTypes);
db.BucketUploadHistory = BucketUploadHistoryDefine(sequelize, DataTypes);
db.UserPermission = UserPermissionDefine(sequelize, DataTypes);
db.PermissionProfile = PermissionProfileDefine(sequelize, DataTypes);

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
db.CampaignTemplate            = CampaignTemplateDefine(sequelize, DataTypes);
db.DocusignSettings            = DocusignSettingsDefine(sequelize, DataTypes);
db.ConditionSignature          = ConditionSignatureDefine(sequelize, DataTypes);
db.McmvMunicipio               = McmvMunicipioDefine(sequelize, DataTypes);
db.McmvImportLog               = McmvImportLogDefine(sequelize, DataTypes);

// Boleto Caixa
db.BoletoSettings      = BoletoSettingsDefine(sequelize, DataTypes);
db.BoletoHistory       = BoletoHistoryDefine(sequelize, DataTypes);
db.BoletoComissionRule = BoletoComissionRuleDefine(sequelize, DataTypes);
db.BoletoEvent         = BoletoEventDefine(sequelize, DataTypes);
db.BoletoEcoLock       = BoletoEcoLockDefine(sequelize, DataTypes);

// Cancelamento de Reservas (CV × Sienge)
db.ReservaCancelSettings = ReservaCancelSettingsDefine(sequelize, DataTypes);
db.ReservaCancelHistory  = ReservaCancelHistoryDefine(sequelize, DataTypes);
db.ReservaCancelEvent    = ReservaCancelEventDefine(sequelize, DataTypes);

// Encurtador de URL
db.ShortLink           = ShortLinkDefine(sequelize, DataTypes);

// OfficeAI Chat
db.ChatSession  = ChatSessionDefine(sequelize, DataTypes);
db.ChatMessage  = ChatMessageDefine(sequelize, DataTypes);
db.UserAIMemory = UserAIMemoryDefine(sequelize, DataTypes);
db.ChatFeedback = ChatFeedbackDefine(sequelize, DataTypes);

// Cérebro da Eme (Brain Studio)
db.EmePromptBlock   = EmePromptBlockDefine(sequelize, DataTypes);
db.EmeGlossaryTerm  = EmeGlossaryTermDefine(sequelize, DataTypes);
db.EmeReport        = EmeReportDefine(sequelize, DataTypes);
db.EmeSetting       = EmeSettingDefine(sequelize, DataTypes);
db.EmeConfigVersion = EmeConfigVersionDefine(sequelize, DataTypes);

// Relatórios da Eme (relatórios customizados gerados por IA)
db.EmeGeneratedReport            = EmeGeneratedReportDefine(sequelize, DataTypes);
db.EmeGeneratedReportVersion     = EmeGeneratedReportVersionDefine(sequelize, DataTypes);
db.EmeGeneratedReportMessage     = EmeGeneratedReportMessageDefine(sequelize, DataTypes);
db.EmeGeneratedReportAccess      = EmeGeneratedReportAccessDefine(sequelize, DataTypes);
db.EmeGeneratedReportPublicLog   = EmeGeneratedReportPublicLogDefine(sequelize, DataTypes);
db.EmeGeneratedReportCustomBlock = EmeGeneratedReportCustomBlockDefine(sequelize, DataTypes);
db.EmeGeneratedReportMemory      = EmeGeneratedReportMemoryDefine(sequelize, DataTypes);
db.EmeGeneratedReportDismissal   = EmeGeneratedReportDismissalDefine(sequelize, DataTypes);

// Notificações
db.Notification           = NotificationDefine(sequelize, DataTypes);
db.NotificationPreference = NotificationPreferenceDefine(sequelize, DataTypes);

// WhatsApp Business
db.WhatsappConfig   = WhatsappConfigDefine(sequelize, DataTypes);
db.WhatsappTemplate = WhatsappTemplateDefine(sequelize, DataTypes);
db.WhatsappMessage  = WhatsappMessageDefine(sequelize, DataTypes);
db.WhatsappAutomation    = WhatsappAutomationDefine(sequelize, DataTypes);
db.WhatsappAutomationRun = WhatsappAutomationRunDefine(sequelize, DataTypes);

// Meta — App compartilhado (WhatsApp + Lead Ads)
db.MetaAppConfig = MetaAppConfigDefine(sequelize, DataTypes);

// Eme Atende — atendente IA de leads via WhatsApp
db.EmeAtendeSetting      = EmeAtendeSettingDefine(sequelize, DataTypes);
db.EmeAtendeApiKey       = EmeAtendeApiKeyDefine(sequelize, DataTypes);
db.EmeAtendeFlow         = EmeAtendeFlowDefine(sequelize, DataTypes);
db.EmeAtendeFlowRule     = EmeAtendeFlowRuleDefine(sequelize, DataTypes);
db.EmeAtendeLead         = EmeAtendeLeadDefine(sequelize, DataTypes);
db.EmeAtendeConversation = EmeAtendeConversationDefine(sequelize, DataTypes);
db.EmeAtendeMessage      = EmeAtendeMessageDefine(sequelize, DataTypes);
db.EmeAtendeEvent        = EmeAtendeEventDefine(sequelize, DataTypes);

db.EmeAtendeFlow.hasMany(db.EmeAtendeFlowRule, { foreignKey: 'flow_id', as: 'rules' });
db.EmeAtendeFlowRule.belongsTo(db.EmeAtendeFlow, { foreignKey: 'flow_id', as: 'flow' });
db.EmeAtendeLead.belongsTo(db.EmeAtendeFlow, { foreignKey: 'flow_id', as: 'flow' });
db.EmeAtendeConversation.belongsTo(db.EmeAtendeLead, { foreignKey: 'lead_id', as: 'lead' });
db.EmeAtendeConversation.belongsTo(db.EmeAtendeFlow, { foreignKey: 'flow_id', as: 'flow' });
db.EmeAtendeMessage.belongsTo(db.EmeAtendeConversation, { foreignKey: 'conversation_id', as: 'conversation' });
db.EmeAtendeConversation.hasMany(db.EmeAtendeMessage, { foreignKey: 'conversation_id', as: 'messages' });
db.EmeAtendeEvent.belongsTo(db.EmeAtendeLead, { foreignKey: 'lead_id', as: 'lead' });
db.EmeAtendeLead.hasMany(db.EmeAtendeEvent, { foreignKey: 'lead_id', as: 'events' });

// Alertas
db.AlertRule         = AlertRuleDefine(sequelize, DataTypes);
db.AlertTriggerLog   = AlertTriggerLogDefine(sequelize, DataTypes);
db.AlertPendingReply = AlertPendingReplyDefine(sequelize, DataTypes);
db.AlertShare        = AlertShareDefine(sequelize, DataTypes);

// Marketing — Captação de Leads
db.InboundLead      = InboundLeadDefine(sequelize, DataTypes);
db.InboundLeadEvent = InboundLeadEventDefine(sequelize, DataTypes);
db.LeadForm         = LeadFormDefine(sequelize, DataTypes);
db.MarketingConfig  = MarketingConfigDefine(sequelize, DataTypes);
db.MetaLeadForm     = MetaLeadFormDefine(sequelize, DataTypes);
db.MetaCampaign     = MetaCampaignDefine(sequelize, DataTypes);
db.MetaAd           = MetaAdDefine(sequelize, DataTypes);
db.MetaAdSet        = MetaAdSetDefine(sequelize, DataTypes);
db.MetaInsightDaily = MetaInsightDailyDefine(sequelize, DataTypes);

// Marketing — Aprovações (tickets p/ diretoria)
db.MarketingApprovalRequest     = MarketingApprovalRequestDefine(sequelize, DataTypes);
db.MarketingApprovalAuthProfile = MarketingApprovalAuthProfileDefine(sequelize, DataTypes);
db.MarketingApprovalDecision    = MarketingApprovalDecisionDefine(sequelize, DataTypes);
db.MarketingApprovalAttachment  = MarketingApprovalAttachmentDefine(sequelize, DataTypes);
db.MarketingApprovalWaMessage   = MarketingApprovalWaMessageDefine(sequelize, DataTypes);
db.MarketingApprovalSettings    = MarketingApprovalSettingsDefine(sequelize, DataTypes);

// Bolão da Copa
db.Bolao            = BolaoDefine(sequelize, DataTypes);
db.BolaoMatch       = BolaoMatchDefine(sequelize, DataTypes);
db.BolaoParticipant = BolaoParticipantDefine(sequelize, DataTypes);
db.BolaoPrediction  = BolaoPredictionDefine(sequelize, DataTypes);

// Mural de Avisos / Comunicados
db.Comunicado           = ComunicadoDefine(sequelize, DataTypes);
db.ComunicadoAssignment = ComunicadoAssignmentDefine(sequelize, DataTypes);
db.ComunicadoReceipt    = ComunicadoReceiptDefine(sequelize, DataTypes);

// Checklist (gestão de lançamentos e demandas)
db.ChecklistTemplate        = ChecklistTemplateDefine(sequelize, DataTypes);
db.ChecklistTemplateSection = ChecklistTemplateSectionDefine(sequelize, DataTypes);
db.ChecklistTemplateItem    = ChecklistTemplateItemDefine(sequelize, DataTypes);
db.Checklist                = ChecklistDefine(sequelize, DataTypes);
db.ChecklistSection         = ChecklistSectionDefine(sequelize, DataTypes);
db.ChecklistStatus          = ChecklistStatusDefine(sequelize, DataTypes);
db.ChecklistTask            = ChecklistTaskDefine(sequelize, DataTypes);
db.ChecklistTaskAttachment  = ChecklistTaskAttachmentDefine(sequelize, DataTypes);
db.ChecklistTaskComment     = ChecklistTaskCommentDefine(sequelize, DataTypes);
db.ChecklistActivity        = ChecklistActivityDefine(sequelize, DataTypes);
db.ChecklistSettings        = ChecklistSettingsDefine(sequelize, DataTypes);
db.ChecklistReminderRule    = ChecklistReminderRuleDefine(sequelize, DataTypes);
db.ChecklistAuthProfile     = ChecklistAuthProfileDefine(sequelize, DataTypes);
db.ChecklistTaskApproval    = ChecklistTaskApprovalDefine(sequelize, DataTypes);

// To Do (Microsoft)
db.TodoTaskRef = TodoTaskRefDefine(sequelize, DataTypes);

// Cadastro de imobiliárias (CV CRM)
db.RealEstateRegistration = RealEstateRegistrationDefine(sequelize, DataTypes);
db.CvImobiliaria = CvImobiliariaDefine(sequelize, DataTypes);

// Se tiver associações, faça-as aqui:
Object.values(db)
  .filter(m => typeof m.associate === 'function')
  .forEach(m => m.associate(db));

db.sequelize = sequelize;
db.Sequelize = Sequelize;
export default db;

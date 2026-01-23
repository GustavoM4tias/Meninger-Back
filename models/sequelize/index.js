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
import SalesContractDefine         from './sienge/salesContract.js'; 
import SiengeBillDefine from './sienge/bill.js';

import ExpenseDefine from './expense.js';

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

import SalesProjectionDefine     from './projection/salesProjection.js';
import SalesProjectionLineDefine from './projection/salesProjectionLine.js';
import SalesProjectionLogDefine  from './projection/salesProjectionLog.js';
import SalesProjectionEnterpriseDefine from './projection/salesProjectionEnterprise.js';

// ... imports existentes
import CvEnterpriseDefine       from './cv/enterprise.js';
import CvEnterpriseStageDefine  from './cv/enterpriseStage.js';
import CvEnterpriseBlockDefine  from './cv/enterpriseBlock.js';
import CvEnterpriseUnitDefine   from './cv/enterpriseUnit.js';
import CvEnterpriseMaterialDefine from './cv/enterpriseMaterial.js';
import CvEnterprisePlanDefine   from './cv/enterprisePlan.js';

import CvWorkflowGroupDefine from './cv/workflowGroup.js';

import landSyncEnterpriseDefine from './landSyncEnterprise.js';

import SiengeAwardDefine from './sienge/award.js';
import SiengeAwardLinkDefine from './sienge/awardLink.js';
import SiengeAwardLogDefine from './sienge/awardLog.js';

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

import ExternalOrganizationDefine from './academy/external/externalOrganization.js';
import AuthAccessCodeDefine from './academy/external/authAccessCode.js';

const env = process.env.NODE_ENV || 'development';

const cfg = config[env];
const sequelize = new Sequelize(cfg.database, cfg.username, cfg.password, {
  host: cfg.host, port: cfg.port, dialect: cfg.dialect,
  define: cfg.define, pool: cfg.pool, logging: false
});

const db = {};
db.User     = UserDefine(sequelize, DataTypes);
db.Position = PositionDefine(sequelize, DataTypes);
db.UserCity = UserCityDefine(sequelize, DataTypes);
db.Department = DepartmentDefine(sequelize, DataTypes);
db.DepartmentCategory = DepartmentCategoryDefine(sequelize, DataTypes);
db.Favorite = FavoriteDefine(sequelize, DataTypes);
db.Event    = EventDefine(sequelize, DataTypes);
db.TokenUsage = TokenUsageDefine(sequelize, DataTypes);
db.ValidationHistory = ValidationHistoryDefine(sequelize, DataTypes);

// sienge db 
db.SalesContract          = SalesContractDefine(sequelize, DataTypes);
db.SiengeBill = SiengeBillDefine(sequelize, DataTypes);

db.Expense = ExpenseDefine(sequelize, DataTypes);

// ... após definir outros modelos:
db.Lead = LeadDefine(sequelize, DataTypes);

db.Repasse = RepasseDefine(sequelize, DataTypes);
// ...
db.Reserva = ReservaDefine(sequelize, DataTypes);

// 👇 REGISTRE AQUI OS NOVOS MODELOS
db.SupportTicket = SupportTicketDefine(sequelize, DataTypes);
db.SupportMessage = SupportMessageDefine(sequelize, DataTypes);

db.EnterpriseCity = EnterpriseCityDefine(sequelize, DataTypes);

db.SalesProjection            = SalesProjectionDefine(sequelize, DataTypes);
db.SalesProjectionLine        = SalesProjectionLineDefine(sequelize, DataTypes);
db.SalesProjectionLog         = SalesProjectionLogDefine(sequelize, DataTypes);
db.SalesProjectionEnterprise  = SalesProjectionEnterpriseDefine(sequelize, DataTypes);

// ... modelos já existentes
db.CvEnterprise        = CvEnterpriseDefine(sequelize, DataTypes);
db.CvEnterpriseStage   = CvEnterpriseStageDefine(sequelize, DataTypes);
db.CvEnterpriseBlock   = CvEnterpriseBlockDefine(sequelize, DataTypes);
db.CvEnterpriseUnit    = CvEnterpriseUnitDefine(sequelize, DataTypes);
db.CvEnterpriseMaterial= CvEnterpriseMaterialDefine(sequelize, DataTypes);
db.CvEnterprisePlan    = CvEnterprisePlanDefine(sequelize, DataTypes);

db.CvWorkflowGroup = CvWorkflowGroupDefine(sequelize, DataTypes);

db.LandSyncEnterprise = landSyncEnterpriseDefine(sequelize, DataTypes);

db.Award = SiengeAwardDefine(sequelize, DataTypes);
db.AwardLink = SiengeAwardLinkDefine(sequelize, DataTypes);
db.AwardLog = SiengeAwardLogDefine(sequelize, DataTypes);

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

db.ExternalOrganization = ExternalOrganizationDefine(sequelize, DataTypes);
db.AuthAccessCode = AuthAccessCodeDefine(sequelize, DataTypes);

// Se tiver associações, faça-as aqui:
Object.values(db)
  .filter(m => typeof m.associate === 'function')
  .forEach(m => m.associate(db));

db.sequelize = sequelize;
db.Sequelize = Sequelize;
export default db;

// /models/sequelize/index.js
import { Sequelize, DataTypes } from 'sequelize';
import dotenv from 'dotenv';
dotenv.config();
import UserDefine from './user.js';
import FavoriteDefine from './favorite.js';
import EventDefine from './event.js';
import config from '../../config/config.cjs';
import TokenUsageDefine from './tokenUsage.js';
import ValidationHistoryDefine from './validationHistory.js';

// Singe imports
import SalesContractDefine         from './sienge/salesContract.js';

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

const env = process.env.NODE_ENV || 'development';

const cfg = config[env];
const sequelize = new Sequelize(cfg.database, cfg.username, cfg.password, {
  host: cfg.host, port: cfg.port, dialect: cfg.dialect,
  define: cfg.define, pool: cfg.pool, logging: false
});

const db = {};
db.User     = UserDefine(sequelize, DataTypes);
db.Favorite = FavoriteDefine(sequelize, DataTypes);
db.Event    = EventDefine(sequelize, DataTypes);
db.TokenUsage = TokenUsageDefine(sequelize, DataTypes);
db.ValidationHistory = ValidationHistoryDefine(sequelize, DataTypes);

// sienge db 
db.SalesContract         = SalesContractDefine(sequelize, DataTypes);

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

// Se tiver associações, faça-as aqui:
Object.values(db)
  .filter(m => typeof m.associate === 'function')
  .forEach(m => m.associate(db));

db.sequelize = sequelize;
db.Sequelize = Sequelize;
export default db;

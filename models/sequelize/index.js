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

// Se tiver associações, faça-as aqui:
Object.values(db)
  .filter(m => typeof m.associate === 'function')
  .forEach(m => m.associate(db));

db.sequelize = sequelize;
db.Sequelize = Sequelize;
export default db;

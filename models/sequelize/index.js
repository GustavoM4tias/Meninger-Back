import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Sequelize, DataTypes } from 'sequelize';
import config from '../../config/config.cjs';

// Definindo __dirname em ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const env = process.env.NODE_ENV || 'development';
const cfg = config[env];
const sequelize = new Sequelize(cfg.database, cfg.username, cfg.password, cfg);

const db = {};
const modelsDir = __dirname;

for (const file of fs.readdirSync(modelsDir)) {
  if (file === 'index.js' || !file.endsWith('.js')) continue;
  const filePath = path.join(modelsDir, file);
  // Converte caminho para URL válida em Windows
  const fileUrl = pathToFileURL(filePath).href;
  const defineModel = (await import(pathToFileURL(path.join(__dirname, file)).href)).default;
  const model = defineModel(sequelize, DataTypes);
  db[model.name] = model;
}

Object.values(db).forEach(model => {
  if (model.associate) {
    model.associate(db);
  }
});

db.sequelize = sequelize;
db.Sequelize = Sequelize;

export default db;
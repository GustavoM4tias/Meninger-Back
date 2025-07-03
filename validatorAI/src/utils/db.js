// validatorAI/src/utils/db.js
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Caminho absoluto até o seu index de Sequelize
const dbPath = path.resolve(__dirname, '../../../models/sequelize/index.js');
// Converte em URL válida para ESM loader do Node
const dbUrl = pathToFileURL(dbPath).href;

// Importa o módulo dinamicamente e pega o default (o objeto db)
const dbModule = await import(dbUrl);
const db = dbModule.default || dbModule;

// Extrai o que precisamos
export const sequelize = db.sequelize;
export const TokenUsage = db.TokenUsage;
export const ValidationHistory = db.ValidationHistory; // ✅ Adicione isto

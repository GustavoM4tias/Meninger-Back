// src/lib/apiCv.js
//
// Cliente das APIs v1/v2 do CV CRM — a autenticação estática por headers
// `email` + `token` (chave de integração). A v3 é outro sistema de credencial
// e vive em lib/apiCvV3.js.
//
// A credencial pode ser administrada pela tela (CV CRM > Configurações), então
// não é mais lida só do ambiente: um interceptor injeta o que estiver gravado
// em cv_panel_settings. Duas garantias que esse interceptor precisa dar, porque
// ESTE cliente é usado por praticamente toda a integração com o CV:
//
//   1. nunca estourar — qualquer falha ao ler o banco cai no valor do ambiente,
//      que é exatamente o comportamento anterior;
//   2. nunca ficar consultando o banco a cada request — o valor é cacheado por
//      um minuto, e a tela derruba o cache ao salvar.

import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const ENV_EMAIL = process.env.CV_API_EMAIL;
const ENV_TOKEN = process.env.CV_API_TOKEN;

const apiCv = axios.create({
  baseURL: process.env.CV_API_BASE_URL,
  headers: {
    Accept: 'application/json',
    email: ENV_EMAIL,
    token: ENV_TOKEN,
  },
  timeout: 300000, // 300s timeout
});

// ── Credencial vinda da tela (com queda para o ambiente) ─────────────────────
const CACHE_MS = 60 * 1000;
let cache = null;   // { email, token, em }

export function invalidarCredencialCv() { cache = null; }

async function credencial() {
  if (cache && (Date.now() - cache.em) < CACHE_MS) return cache;
  try {
    const { default: db } = await import('../models/sequelize/index.js');
    const s = await db.CvPanelSettings.findByPk(1);
    cache = {
      email: s?.api_email || ENV_EMAIL,
      token: s?.api_token || ENV_TOKEN,
      em: Date.now(),
    };
  } catch {
    // Banco fora, tabela ainda não criada, boot antes do model: o ambiente
    // responde, e o CV continua funcionando como sempre funcionou.
    cache = { email: ENV_EMAIL, token: ENV_TOKEN, em: Date.now() };
  }
  return cache;
}

apiCv.interceptors.request.use(async (config) => {
  try {
    const c = await credencial();
    if (c.email) config.headers.email = c.email;
    if (c.token) config.headers.token = c.token;
  } catch { /* mantém os headers do ambiente */ }
  return config;
});

// Interceptor global de erros (aqui você pode logar ou transformar)
apiCv.interceptors.response.use(
  response => response,
  error => Promise.reject(error)
);

/** Estado da credencial v1/v2 para a tela. Nunca devolve o token. */
export async function statusApiCv() {
  const c = await credencial();
  let daTela = false;
  try {
    const { default: db } = await import('../models/sequelize/index.js');
    const s = await db.CvPanelSettings.findByPk(1);
    daTela = !!(s?.api_email || s?.api_token);
  } catch { /* segue com o padrão */ }

  return {
    base_url: process.env.CV_API_BASE_URL || null,
    email: c.email || null,
    token_definido: !!c.token,
    // De onde veio o que está valendo agora: ajuda a não caçar fantasma quando
    // alguém troca no Railway e não entende por que nada mudou.
    origem: daTela ? 'tela' : 'ambiente',
  };
}

/**
 * Testa a credencial v1/v2 com uma chamada barata e real. Devolve
 * { ok, mensagem } em vez de estourar, porque quem chamou quer mostrar o
 * resultado no formulário.
 */
export async function testarApiCv() {
  try {
    const r = await apiCv.get('/v1/cadastros/empreendimentos', { timeout: 30000 });
    const n = Array.isArray(r.data) ? r.data.length : Object.keys(r.data || {}).length;
    return { ok: true, mensagem: `Conexão com o CV funcionou (${n} empreendimento(s) na resposta).` };
  } catch (err) {
    const st = err.response?.status;
    const msg = err.response?.data?.mensagem || err.response?.data?.message || err.message;
    return { ok: false, mensagem: st ? `CV respondeu ${st}: ${msg}` : String(msg) };
  }
}

export default apiCv;

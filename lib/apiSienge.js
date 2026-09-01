// src/lib/apiSienge.js
import axios from 'axios';
import dotenv from 'dotenv';
import { Buffer } from 'buffer';
import crypto from 'crypto';
import { getConnection } from '../services/sienge/siengeConnection.js';

dotenv.config();

// Painel de nuvem guarda o que foi COLADO. Valor que entra com aspas em volta,
// espaço ou quebra de linha no fim vira parte da senha no header Basic, e a API
// responde 401 "Invalid authentication credentials" — falha que só aparece em
// produção, porque o .env local nunca passa por copiar e colar. Em vez de
// confiar no que veio, limpamos e dizemos no log que precisou limpar.
const limpar = (v) => String(v ?? '').trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();

const user = limpar(process.env.SIENGE_API_USER);
const password = limpar(process.env.SIENGE_API_PASSWORD);
const baseURL = limpar(process.env.SIENGE_API_BASE_URL);
const base64Token = Buffer.from(`${user}:${password}`).toString('base64');

// Impressão digital da credencial: prova QUAL credencial este processo está
// usando, sem imprimir a senha. Existe porque um 401 do Sienge que só acontece
// em produção é indistinguível de bug de código olhando de fora (26/08/2026);
// com o digest, comparar ambiente com ambiente leva um segundo.
const digest = (v) => (v ? crypto.createHash('sha1').update(v).digest('hex').slice(0, 8) : 'vazio');
console.log(
  `[env] Sienge API: base=${baseURL || '(vazio)'} user=${user || '(vazio)'} ` +
  `senha=${password.length} chars sha1:${digest(password)}`
);
for (const [nome, cru] of [
  ['SIENGE_API_USER', process.env.SIENGE_API_USER],
  ['SIENGE_API_PASSWORD', process.env.SIENGE_API_PASSWORD],
  ['SIENGE_API_BASE_URL', process.env.SIENGE_API_BASE_URL],
]) {
  if (cru != null && cru !== limpar(cru)) {
    console.warn(`⚠️  [env] ${nome} veio com aspas ou espaço em volta — limpo aqui, mas corrija no painel.`);
  }
}

const apiSienge = axios.create({
  // Os valores do .env ficam como PISO da instância. O interceptor abaixo
  // sobrescreve com o que estiver na aba Configuração da tela Sienge — que é
  // exatamente onde os mesmos campos passaram a poder ser corrigidos sem deploy.
  baseURL,
  headers: {
    Accept: 'application/json',
    Authorization: `Basic ${base64Token}`,
  },
  timeout: 45000,
});

// Credencial em vigor, resolvida uma vez e reusada. O cache é curto de propósito
// (a fonte, siengeConnection, já cacheia 30 s); aqui ele só evita um await por
// requisição num caminho quente.
let _creds = null;

async function resolveCredentials() {
  if (_creds) return _creds;
  try {
    const cfg = await getConnection({ withSecrets: true });
    _creds = {
      baseURL: cfg.api_base_url || baseURL,
      token: Buffer.from(`${cfg.api_user ?? ''}:${cfg.api_password ?? ''}`).toString('base64'),
    };
  } catch (err) {
    // Banco fora do ar não pode derrubar a integração: segue com o .env.
    console.warn('[apiSienge] credencial da tela indisponível, usando o .env:', err.message);
    _creds = { baseURL, token: base64Token };
  }
  return _creds;
}

/** Chamada pela tela de Configuração depois de salvar. */
export function invalidateApiSiengeCredentials() { _creds = null; }

apiSienge.interceptors.request.use(async (config) => {
  const creds = await resolveCredentials();
  if (creds.baseURL) config.baseURL = creds.baseURL;
  config.headers = config.headers || {};
  config.headers.Authorization = `Basic ${creds.token}`;
  return config;
});

// Interceptor global de erros
apiSienge.interceptors.response.use(
  response => response,
  error => Promise.reject(error)
);

export default apiSienge;

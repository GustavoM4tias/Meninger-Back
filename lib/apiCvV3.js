// lib/apiCvV3.js
//
// Cliente das APIs v3 do CV CRM.
//
// A v1/v2 (lib/apiCv.js) autentica com os headers `email` + `token` de
// integração. A v3 NÃO aceita isso: exige `Authorization: Bearer <JWT>`, e o
// JWT sai de POST /v3/auth/token com { email, senha, painel }. Mandar o token
// de integração como Bearer devolve 403 "Wrong number of segments" (ele não é
// um JWT), e mandar os headers antigos devolve 401.
//
// A credencial aqui é de um USUÁRIO do painel Gestor, não a chave de
// integração - vem de CV_PANEL_EMAIL / CV_PANEL_SENHA. Sem elas o cliente não
// tenta nada e avisa quem chamou (`isConfigured()`), para o resto do sistema
// seguir funcionando com o que a v1 entrega.
//
// O JWT é guardado em memória e renovado sozinho: quando expira (exp do
// proprio token) ou quando uma chamada volta 401/403.

import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const BASE = process.env.CV_API_BASE_URL;
const EMAIL = process.env.CV_PANEL_EMAIL || '';
const SENHA = process.env.CV_PANEL_SENHA || '';
const PAINEL = process.env.CV_PANEL_PAINEL || 'gestor';

// Margem para não usar um token que expira no meio da chamada.
const FOLGA_MS = 60 * 1000;

let cache = null;        // { token, expiraEm }
let loginEmVoo = null;

export function isConfigured() {
    return !!(BASE && EMAIL && SENHA);
}

/** `exp` do JWT, em ms. Sem exp legível, assume 50 min. */
function expiracaoDoToken(jwt) {
    try {
        const payload = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'));
        if (payload?.exp) return Number(payload.exp) * 1000;
    } catch { /* token opaco: cai no padrão */ }
    return Date.now() + 50 * 60 * 1000;
}

async function autenticar() {
    const { data } = await axios.post(`${BASE}/v3/auth/token`,
        { email: EMAIL, senha: SENHA, painel: PAINEL },
        { headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, timeout: 30000 });

    // A resposta já variou de formato entre versões da doc; aceitamos os
    // lugares plausíveis em vez de quebrar por causa de um nível de aninhamento.
    const token = data?.data?.token || data?.token || data?.data?.access_token || data?.access_token;
    if (!token) throw new Error(`Login v3 sem token na resposta: ${JSON.stringify(data).slice(0, 200)}`);

    cache = { token, expiraEm: expiracaoDoToken(token) };
    return token;
}

async function tokenValido(forcar = false) {
    if (!isConfigured()) throw new Error('CV v3 sem credencial: defina CV_PANEL_EMAIL e CV_PANEL_SENHA.');
    if (!forcar && cache && Date.now() < cache.expiraEm - FOLGA_MS) return cache.token;
    if (!loginEmVoo) loginEmVoo = autenticar().finally(() => { loginEmVoo = null; });
    return loginEmVoo;
}

/**
 * GET numa rota v3. Renova o JWT e repete UMA vez se o CV recusar a
 * autorização (token revogado ou expirado antes da hora).
 */
export async function getV3(path, config = {}) {
    let token = await tokenValido();
    const chamar = () => axios.get(`${BASE}${path}`, {
        ...config,
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(config.headers || {}) },
        timeout: config.timeout || 60000,
    });

    try {
        return await chamar();
    } catch (err) {
        const st = err.response?.status;
        if (st !== 401 && st !== 403) throw err;
        token = await tokenValido(true);
        return chamar();
    }
}

export default { getV3, isConfigured };

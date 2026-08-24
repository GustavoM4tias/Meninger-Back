// lib/apiCvV3.js
//
// Cliente das APIs v3 do CV CRM.
//
// A v1/v2 (lib/apiCv.js) autentica com os headers `email` + `token` de
// integração. A v3 NÃO aceita isso, e não é questão de formato: são dois
// sistemas de credencial diferentes. Medido contra o CV em 2026-08-24, com o
// token da v1 mandado de dez jeitos (Bearer, Token, cru, header `token`,
// X-API-Key, apikey, query string): todos 401, menos Bearer, que dá 403
// "Wrong number of segments" porque o token da v1 tem 40 caracteres e nenhum
// ponto - não é um JWT. A doc oficial confirma: a v3 exige e-mail e senha de
// um usuário administrativo ativo.
//
//   POST /v3/auth/token  { email, senha, painel }   painel: gestor|corretor|imobiliaria
//   -> { status, code, data: { access_token (JWT, 6h), refresh_token, ... } }
//
// A credencial mora em cv_panel_settings, editável por tela, porque o CV FORÇA
// troca de senha de tempos em tempos. Se ela ficasse no .env, cada rotação
// derrubaria a leitura até alguém fazer deploy - e, pior, em silêncio.
// Por isso todo login registra sucesso/falha na tabela e a falha de credencial
// avisa quem está configurado para ser avisado, uma vez por episódio.

import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const BASE = process.env.CV_API_BASE_URL;
const FOLGA_MS = 60 * 1000;   // não usar token que expira no meio da chamada

let cache = null;        // { token, expiraEm }
let loginEmVoo = null;

async function settings() {
    const { default: db } = await import('../models/sequelize/index.js');
    let s = await db.CvPanelSettings.findByPk(1);
    if (!s) s = await db.CvPanelSettings.create({ id: 1, painel: 'gestor' });
    return s;
}

/** Tem credencial gravada? (não diz se ela ainda é válida) */
export async function isConfigured() {
    try {
        const s = await settings();
        return !!(BASE && s.email && s.senha);
    } catch {
        return false;
    }
}

/** Estado da integração, para a tela e para o diagnóstico. Nunca devolve a senha. */
export async function statusV3() {
    const s = await settings();
    return {
        configurado: !!(BASE && s.email && s.senha),
        email: s.email || null,
        painel: s.painel || 'gestor',
        senha_definida: !!s.senha,
        notify_user_ids: Array.isArray(s.notify_user_ids) ? s.notify_user_ids : [],
        last_ok_at: s.last_ok_at,
        last_error: s.last_error,
        last_error_at: s.last_error_at,
        // Saudável = a última tentativa boa é mais recente que a última ruim.
        saudavel: !!s.last_ok_at && (!s.last_error_at || s.last_ok_at > s.last_error_at),
    };
}

/** `exp` do JWT, em ms. Sem exp legível, assume 50 min. */
function expiracaoDoToken(jwt) {
    try {
        const payload = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'));
        if (payload?.exp) return Number(payload.exp) * 1000;
    } catch { /* token opaco: cai no padrão */ }
    return Date.now() + 50 * 60 * 1000;
}

// Credencial trocada/vencida é o que interessa avisar. CV fora do ar ou rede
// ruim é passageiro, e avisar disso ensinaria todo mundo a ignorar o aviso.
const ehCredencial = (err) => {
    const st = err.response?.status;
    const msg = String(err.response?.data?.message || err.message || '');
    return st === 400 || st === 401 || st === 403 || /senha|usu[áa]rio|autoriza/i.test(msg);
};

async function avisarResponsaveis(s, mensagem) {
    if (s.alert_sent_at) return;   // um aviso por episódio
    try {
        const [{ default: NotificationService }, { NotificationType }, { default: db }] = await Promise.all([
            import('../services/notification/NotificationService.js'),
            import('../services/notification/notificationTypes.js'),
            import('../models/sequelize/index.js'),
        ]);

        // Configurado na tela; vazio cai em TODOS os admins, que é o padrão
        // seguro - o pior desfecho aqui é o aviso não ter destinatário.
        const escolhidos = Array.isArray(s.notify_user_ids) ? s.notify_user_ids.map(Number).filter(Boolean) : [];
        const users = escolhidos.length
            ? escolhidos
            : (await db.User.findAll({ where: { role: 'admin' }, attributes: ['id'], raw: true })).map(a => a.id);
        if (!users.length) return;

        await NotificationService.notify({
            type: NotificationType.CV_PANEL_CREDENTIAL_FAILED,
            recipients: { users },
            title: 'A senha do CV parou de funcionar',
            body: `A leitura de imobiliárias por empreendimento está parada: ${mensagem}. `
                + 'O CV troca a senha de tempos em tempos - atualize em CV CRM > Configurações.',
            link: '/crm/configuracoes',
            importance: 8,
        });
        await s.update({ alert_sent_at: new Date() });
    } catch (e) {
        console.warn('[CV v3] falhou ao avisar sobre a credencial:', e?.message);
    }
}

async function autenticar() {
    const s = await settings();
    if (!BASE || !s.email || !s.senha) throw new Error('Credencial do painel do CV não configurada.');

    try {
        const { data } = await axios.post(`${BASE}/v3/auth/token`,
            { email: s.email, senha: s.senha, painel: s.painel || 'gestor' },
            { headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, timeout: 30000 });

        // O JWT vem em data.data.access_token; os outros caminhos são tolerância
        // a mudança de formato, não chute.
        const token = data?.data?.access_token || data?.access_token || data?.data?.token || data?.token;
        if (!token) throw new Error('login sem access_token na resposta');

        cache = { token, expiraEm: expiracaoDoToken(token) };
        await s.update({ last_ok_at: new Date(), last_error: null, last_error_at: null, alert_sent_at: null });
        return token;
    } catch (err) {
        const msg = err.response?.data?.message || err.message;
        await s.update({ last_error: String(msg).slice(0, 500), last_error_at: new Date() });
        if (ehCredencial(err)) await avisarResponsaveis(s, msg);
        throw new Error(`Login v3 do CV falhou: ${msg}`);
    }
}

async function tokenValido(forcar = false) {
    if (!forcar && cache && Date.now() < cache.expiraEm - FOLGA_MS) return cache.token;
    if (!loginEmVoo) loginEmVoo = autenticar().finally(() => { loginEmVoo = null; });
    return loginEmVoo;
}

/**
 * GET numa rota v3. Renova o JWT e repete UMA vez se o CV recusar a
 * autorização (token revogado, ou expirado antes da hora prevista).
 */
export async function getV3(path, config = {}) {
    let token = await tokenValido();
    const chamar = (tk) => axios.get(`${BASE}${path}`, {
        ...config,
        headers: { Accept: 'application/json', Authorization: `Bearer ${tk}`, ...(config.headers || {}) },
        timeout: config.timeout || 60000,
    });

    try {
        return await chamar(token);
    } catch (err) {
        const st = err.response?.status;
        if (st !== 401 && st !== 403) throw err;
        cache = null;
        token = await tokenValido(true);
        return chamar(token);
    }
}

/**
 * Testa a credencial na hora (a tela chama isto ao salvar). Devolve
 * { ok, mensagem } em vez de estourar, porque quem chamou quer mostrar o
 * resultado no formulário.
 */
export async function testarCredencial() {
    cache = null;
    try {
        await autenticar();
        return { ok: true, mensagem: 'Login no CV funcionou.' };
    } catch (err) {
        return { ok: false, mensagem: err.message };
    }
}

export default { getV3, isConfigured, statusV3, testarCredencial };

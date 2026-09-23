// lib/cvPanelWeb.js
//
// Sessão WEB do painel do CV (as telas antigas em PHP), usada para ler o que
// nenhuma API do CV entrega.
//
// Por que existe: o MOTIVO do bloqueio de uma unidade ("Estratégia Comercial",
// "Bloqueada - Administrada pelo SIENGE", "Negociação de Terreno") não vem em
// lugar nenhum da API. O `/cvio/empreendimento/:id` traz `situacao` e
// `data_bloqueio` e para por aí — medido em 22/09/2026 lendo o payload inteiro.
// Sem o motivo, o Office não consegue separar "bloqueada porque o ERP travou"
// de "bloqueada porque a diretoria segurou o estoque", que é exatamente a
// diferença entre unidade fora do jogo e unidade que ainda é estoque comercial.
//
// A credencial é a MESMA de cv_panel_settings (email/senha do usuário do
// painel) que a v3 já usa — não há credencial nova para alguém manter. A v3
// autentica por JWT e não serve aqui: as telas antigas são sessão PHP.
//
// O login é o form padrão do CV: POST na raiz do painel com `opLogin`,
// `txt_usuario` e `txt_senha`, e a resposta devolve o cookie de sessão.
//
// Fragilidade assumida: isto é leitura de HTML. Se o CV mudar o layout da
// listagem de unidades, o parse para. Por isso a leitura NUNCA apaga o que já
// sabe quando não entende a página — ela falha barulhenta (erro no job, que
// aparece em CV CRM > Sincronizações) e o Office segue com o último dado bom.

import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// O painel web mora na raiz do domínio do CV, não no /api da chave de
// integração: CV_API_BASE_URL aponta para .../api.
const BASE = String(process.env.CV_API_BASE_URL || '').replace(/\/api\/?$/, '');

// O painel é uma tela, não uma API: alguns caminhos do CV tratam cliente sem
// User-Agent de navegador de forma diferente.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

let sessao = null;       // { cookie, criadaEm }
let loginEmVoo = null;

const VALIDADE_MS = 20 * 60 * 1000;   // o CV expira a sessão; 20 min é folgado

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

function cookieDaResposta(res) {
    const bruto = res.headers?.['set-cookie'];
    if (!Array.isArray(bruto) || !bruto.length) return null;
    return bruto.map((c) => String(c).split(';')[0]).join('; ');
}

async function autenticar() {
    const s = await settings();
    if (!BASE) throw new Error('CV_API_BASE_URL não configurada.');
    if (!s.email || !s.senha) throw new Error('Credencial do painel do CV não configurada.');

    const painel = s.painel || 'gestor';
    const url = `${BASE}/${painel}/`;

    try {
        // 1) GET primeiro: o PHP só aceita o POST dentro de uma sessão que ele
        // mesmo abriu, então o cookie inicial vem daqui.
        const inicial = await axios.get(url, {
            headers: { Accept: 'text/html', 'User-Agent': UA },
            timeout: 45000,
            validateStatus: (st) => st >= 200 && st < 400,
        });
        const cookieInicial = cookieDaResposta(inicial);

        // 2) POST do form. Três detalhes que o CV não perdoa, todos medidos no
        // HTML do painel em 23/09/2026:
        //  - `opLogin` vale "login" (com "1" o CV devolve o formulário de novo);
        //  - há um `token_csrf` que a PÁGINA injeta por JavaScript no submit,
        //    então ele não aparece como <input> e precisa ser extraído do
        //    script; sem ele o login é recusado sem dizer por quê;
        //  - o token vale para a sessão do GET acima, por isso os dois passos
        //    compartilham o mesmo cookie.
        const html = String(inicial.data || '');
        // O token aparece no script como .attr("value", "<hex>") logo depois
        // de .attr("name", "token_csrf"); o segundo padrao cobre variacoes de
        // formatacao sem depender da quebra de linha.
        const csrf = (html.match(/token_csrf[\s\S]{0,160}?([a-f0-9]{40,})/i) || [])[1] || null;

        const corpo = new URLSearchParams({
            opLogin: 'login',
            txt_usuario: s.email,
            txt_senha: s.senha,
            token_login_social: '',
            email_social: '',
            ...(csrf ? { token_csrf: csrf } : {}),
        });

        const res = await axios.post(url, corpo.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'text/html',
                'User-Agent': UA,
                Referer: url,
                Origin: BASE,
                ...(cookieInicial ? { Cookie: cookieInicial } : {}),
            },
            timeout: 45000,
            maxRedirects: 0,
            // 302 é o sucesso esperado; sem isto o axios trata como erro.
            validateStatus: (st) => st >= 200 && st < 400,
        });

        // O PHP costuma renovar o cookie no login; quando não renova, vale o
        // da abertura da sessão.
        const cookie = cookieDaResposta(res) || cookieInicial;
        if (!cookie) throw new Error('login sem cookie de sessão na resposta');

        // NÃO dá para validar a sessão procurando o formulário de login: o
        // painel serve a mesma casca para tudo e ela carrega o `formLogin`
        // escondido mesmo com o usuário logado (medido em 23/09/2026 - os
        // HTMLs logado e deslogado de /cadastros/empreendimentos são idênticos,
        // byte a byte, porque o conteúdo real vem por iframe).
        //
        // Quem valida de verdade é quem lê: a página de unidades ou traz a
        // tabela com "Motivo bloqueio", ou o parser estoura dizendo isso.
        sessao = { cookie, criadaEm: Date.now() };
        await s.update({ last_ok_at: new Date(), last_error: null, last_error_at: null, alert_sent_at: null });
        return cookie;
    } catch (err) {
        const msg = err.response?.status ? `HTTP ${err.response.status}` : err.message;
        await s.update({ last_error: String(msg).slice(0, 500), last_error_at: new Date() });
        throw new Error(`Login no painel do CV falhou: ${msg}`);
    }
}

async function cookieValido(forcar = false) {
    if (!forcar && sessao && Date.now() - sessao.criadaEm < VALIDADE_MS) return sessao.cookie;
    if (!loginEmVoo) loginEmVoo = autenticar().finally(() => { loginEmVoo = null; });
    return loginEmVoo;
}

/**
 * GET numa tela do painel; devolve o HTML.
 *
 * `ok(html)` diz se a resposta é o conteúdo esperado. Quando não é, a sessão
 * provavelmente expirou no meio da varredura: refaz o login UMA vez e tenta de
 * novo. Sem esse teste do chamador não há como saber - a casca do painel é
 * igual logado e deslogado.
 */
export async function getHtml(path, config = {}, ok = null) {
    const chamar = async (cookie) => {
        const res = await axios.get(path.startsWith('http') ? path : `${BASE}${path}`, {
            ...config,
            headers: { Cookie: cookie, Accept: 'text/html', 'User-Agent': UA, ...(config.headers || {}) },
            timeout: config.timeout || 90000,
            validateStatus: (st) => st >= 200 && st < 400,
        });
        return String(res.data || '');
    };

    let cookie = await cookieValido();
    let html = await chamar(cookie);

    if (typeof ok === 'function' && !ok(html)) {
        sessao = null;
        cookie = await cookieValido(true);
        html = await chamar(cookie);
    }
    return html;
}

/** Descarta a sessão em memória (o próximo GET faz login de novo). */
export function invalidarSessao() {
    sessao = null;
}

/** Testa a credencial na hora, para a tela mostrar o resultado. */
export async function testarSessao() {
    try {
        sessao = null;
        await cookieValido(true);
        return { ok: true, mensagem: 'Sessão do painel aberta com sucesso.' };
    } catch (err) {
        return { ok: false, mensagem: err.message };
    }
}

export default { isConfigured, getHtml, testarSessao, invalidarSessao };

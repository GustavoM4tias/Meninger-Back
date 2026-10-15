// lib/cvPainelSessao.js
//
// A sessão do painel do CV que o robô usa, conectada por uma pessoa.
//
// O login do painel tem Cloudflare Turnstile (memória "CV: painel tem CAPTCHA
// no login"), e robô não resolve CAPTCHA. O caminho legítimo é: alguém entra no
// CV com o usuário do robô (sistema@menin.com.br), resolve o CAPTCHA, copia o
// cookie `CVid` e cola em CV CRM > Configurações. Daí em diante este módulo:
//
//  - mantém a sessão viva chamando `/{painel}/?acao=atualizaSessao`, o MESMO
//    endereço que a página do painel chama para não deslogar quem está com ela
//    aberta (medido em 15/10/2026: 200, JSON de 77 bytes com a hora do
//    servidor). Custa uma requisição pequena a cada poucos minutos, sem IA;
//  - percebe quando a sessão caiu (a resposta vira a página de login) e avisa
//    quem está na lista de avisados da credencial do CV, uma vez por episódio.
//
// O cookie é segredo de acesso: fica criptografado (utils/encryption.js) e
// nunca volta para a tela.

import axios from 'axios';
import dotenv from 'dotenv';
import db from '../models/sequelize/index.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { ensureCvRoboSchema } from './ensureCvRoboSchema.js';

dotenv.config();

const BASE = String(process.env.CV_API_BASE_URL || '').replace(/\/api\/?$/, '');
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

async function painel() {
    try {
        const s = await db.CvPanelSettings.findByPk(1, { attributes: ['painel'] });
        return s?.painel || 'gestor';
    } catch {
        return 'gestor';
    }
}

async function linha() {
    await ensureCvRoboSchema();
    const [rows] = await db.sequelize.query('SELECT * FROM cv_painel_sessao WHERE id = 1');
    return rows[0] || {};
}

async function gravar(patch) {
    const campos = Object.keys(patch);
    if (!campos.length) return;
    const sets = campos.map((c) => `${c} = :${c}`).join(', ');
    await db.sequelize.query(`UPDATE cv_painel_sessao SET ${sets}, updated_at = NOW() WHERE id = 1`, { replacements: patch });
}

/**
 * Aceita o que a pessoa colar: só o valor ("abc123"), "CVid=abc123" ou o
 * cabeçalho inteiro ("x=1; CVid=abc123"). Devolve o cabeçalho Cookie pronto.
 */
export function normalizarCookie(texto) {
    const bruto = String(texto || '').trim().replace(/^cookie:\s*/i, '');
    if (!bruto) return null;
    if (!bruto.includes('=')) {
        if (!/^[A-Za-z0-9%._-]{8,}$/.test(bruto)) return null;
        return `CVid=${bruto}`;
    }
    const partes = bruto.split(';').map((p) => p.trim()).filter((p) => /^[^=\s]+=.+$/.test(p));
    if (!partes.length) return null;
    return partes.join('; ');
}

/**
 * Chama o "mantenha viva" do painel com o cookie. Distingue sessão caída
 * (o CV devolve a página de login) de falha passageira (rede, 5xx): só a
 * primeira derruba a sessão; a segunda só vira erro do job.
 */
export async function testarCookie(cookie) {
    const url = `${BASE}/${await painel()}/?acao=atualizaSessao`;
    try {
        const res = await axios.get(url, {
            headers: { Cookie: cookie, Accept: 'application/json, text/html', 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest' },
            timeout: 30000,
            maxRedirects: 0,
            validateStatus: () => true,
            responseType: 'text',
            transformResponse: (d) => d,
        });
        const corpo = String(res.data || '');
        if (res.status >= 500) return { ok: false, caiu: false, motivo: `CV respondeu HTTP ${res.status}` };
        if (res.status >= 300 && res.status < 400) return { ok: false, caiu: true, motivo: 'o CV redirecionou para o login' };
        let json = null;
        try { json = JSON.parse(corpo); } catch { /* página HTML = deslogado */ }
        if (json && json.sucesso !== undefined) return { ok: true, caiu: false, horaServidor: Number(json.sucesso) || null };
        if (/txt_usuario|formLogin/i.test(corpo)) return { ok: false, caiu: true, motivo: 'o CV pediu login de novo (sessão expirada ou encerrada)' };
        return { ok: false, caiu: false, motivo: `resposta inesperada do CV (${corpo.length} bytes)` };
    } catch (err) {
        return { ok: false, caiu: false, motivo: err.message };
    }
}

/** Cookie da sessão conectada e ainda viva; null se não há ou se caiu. */
export async function cookieAtivo() {
    const l = await linha();
    if (!l.cookie_enc || l.perdida_em) return null;
    return decrypt(l.cookie_enc);
}

/** Estado para a tela. Nunca devolve o cookie. */
export async function statusSessao() {
    const l = await linha();
    const conectada = !!l.cookie_enc;
    return {
        conectada,
        viva: conectada && !l.perdida_em,
        definida_em: l.definida_em || null,
        definida_por_nome: l.definida_por_nome || null,
        ultimo_ok_em: l.ultimo_ok_em || null,
        pings_ok: Number(l.pings_ok || 0),
        perdida_em: l.perdida_em || null,
        perdida_motivo: l.perdida_motivo || null,
        // Quanto tempo a sessão durou (ou dura): é o número que responde se o
        // CV derruba sessão por tempo total mesmo com o "mantenha viva".
        duracao_min: l.definida_em
            ? Math.round(((l.perdida_em ? new Date(l.perdida_em) : new Date()) - new Date(l.definida_em)) / 60000)
            : null,
    };
}

async function avisarQueda(motivo) {
    const l = await linha();
    if (l.aviso_enviado_em) return;
    try {
        const [{ default: NotificationService }, { NotificationType }] = await Promise.all([
            import('../services/notification/NotificationService.js'),
            import('../services/notification/notificationTypes.js'),
        ]);
        const s = await db.CvPanelSettings.findByPk(1, { attributes: ['notify_user_ids'] });
        const escolhidos = Array.isArray(s?.notify_user_ids) ? s.notify_user_ids.map(Number).filter(Boolean) : [];
        const users = escolhidos.length
            ? escolhidos
            : (await db.User.findAll({ where: { role: 'admin' }, attributes: ['id'], raw: true })).map((a) => a.id);
        if (!users.length) return;

        await NotificationService.notify({
            type: NotificationType.CV_PANEL_SESSION_LOST,
            recipients: { users },
            title: 'O robô do CV saiu do painel',
            body: `A sessão do robô no painel do CV caiu: ${motivo}. A reaprovação automática está parada até alguém `
                + 'entrar no CV com o usuário do robô e colar a sessão de novo em CV CRM > Configurações.',
            link: '/crm/configuracoes',
            importance: 8,
        });
        await gravar({ aviso_enviado_em: new Date() });
    } catch (e) {
        console.warn('[CV robô] falhou ao avisar a queda da sessão:', e?.message);
    }
}

export async function marcarPerdida(motivo) {
    const l = await linha();
    if (l.perdida_em) return;
    await gravar({ perdida_em: new Date(), perdida_motivo: String(motivo || 'sessão caiu').slice(0, 500) });
    console.warn(`[CV robô] sessão do painel caiu: ${motivo}`);
    await avisarQueda(motivo);
}

/** Cola uma sessão nova: testa antes de gravar, para a tela dizer na hora se pegou. */
export async function conectarSessao(texto, user) {
    const cookie = normalizarCookie(texto);
    if (!cookie) return { ok: false, mensagem: 'Não reconheci o cookie colado. Copie o valor do cookie CVid do CV.' };

    const t = await testarCookie(cookie);
    if (!t.ok) {
        return {
            ok: false,
            mensagem: t.caiu
                ? 'O CV não aceitou esta sessão (pediu login). Entre de novo no CV, copie o CVid novo e cole sem clicar em Sair.'
                : `Não consegui testar a sessão agora: ${t.motivo}`,
        };
    }

    await gravar({
        cookie_enc: encrypt(cookie),
        definida_em: new Date(),
        definida_por: user?.id || null,
        definida_por_nome: user?.username || user?.email || null,
        ultimo_ok_em: new Date(),
        pings_ok: 0,
        perdida_em: null,
        perdida_motivo: null,
        aviso_enviado_em: null,
    });
    return { ok: true, mensagem: 'Sessão do robô conectada. O Office passa a mantê-la viva sozinho.' };
}

export async function desconectarSessao() {
    await gravar({ cookie_enc: null, perdida_em: null, perdida_motivo: null, aviso_enviado_em: null, pings_ok: 0 });
    return { ok: true, mensagem: 'Sessão do robô removida.' };
}

/**
 * O "mantenha viva". Roda no cron do robô. Sem sessão conectada não faz nada
 * (não é erro: o robô é opcional). Queda real derruba e avisa; falha
 * passageira estoura para o job aparecer vermelho, sem matar a sessão.
 */
export async function manterViva() {
    const cookie = await cookieAtivo();
    if (!cookie) return { sessao: 'ausente' };

    const t = await testarCookie(cookie);
    if (t.ok) {
        await db.sequelize.query(
            'UPDATE cv_painel_sessao SET ultimo_ok_em = NOW(), pings_ok = pings_ok + 1, updated_at = NOW() WHERE id = 1'
        );
        return { sessao: 'viva' };
    }
    if (t.caiu) {
        await marcarPerdida(t.motivo);
        return { sessao: 'caiu', motivo: t.motivo };
    }
    throw new Error(`mantenha viva do painel falhou: ${t.motivo}`);
}

/** GET de tela do painel com a sessão do robô. Devolve o HTML. */
export async function getPainel(path, ok = null) {
    const cookie = await cookieAtivo();
    if (!cookie) throw new Error('o robô não tem sessão no painel do CV (conecte em CV CRM > Configurações)');
    const res = await axios.get(`${BASE}${path}`, {
        headers: { Cookie: cookie, Accept: 'text/html', 'User-Agent': UA },
        timeout: 60000,
        maxRedirects: 0,
        validateStatus: (st) => st >= 200 && st < 400,
        responseType: 'text',
        transformResponse: (d) => d,
    });
    const html = String(res.data || '');
    if (typeof ok === 'function' && !ok(html)) {
        // A casca do painel é igual logado e deslogado; só o "mantenha viva"
        // diz com certeza se a sessão caiu.
        const t = await testarCookie(cookie);
        if (t.caiu) {
            await marcarPerdida(t.motivo);
            throw new Error(`a sessão do robô no painel caiu: ${t.motivo}`);
        }
        throw new Error(`o painel não devolveu a tela esperada em ${path}`);
    }
    return html;
}

/** POST de formulário do painel com a sessão do robô (o mesmo envio do botão). */
export async function postPainel(path, campos, referer = null) {
    const cookie = await cookieAtivo();
    if (!cookie) throw new Error('o robô não tem sessão no painel do CV');
    const corpo = new URLSearchParams();
    for (const [k, v] of campos) corpo.append(k, v ?? '');
    const res = await axios.post(`${BASE}${path}`, corpo.toString(), {
        headers: {
            Cookie: cookie,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'text/html',
            'User-Agent': UA,
            Origin: BASE,
            Referer: referer ? `${BASE}${referer}` : `${BASE}${path}`,
        },
        timeout: 60000,
        maxRedirects: 0,
        validateStatus: () => true,
        responseType: 'text',
        transformResponse: (d) => d,
    });
    return { status: res.status, location: res.headers?.location || null, html: String(res.data || '') };
}

export async function painelAtual() {
    return painel();
}

export default {
    normalizarCookie, testarCookie, cookieAtivo, statusSessao, conectarSessao, desconectarSessao,
    manterViva, marcarPerdida, getPainel, postPainel, painelAtual,
};

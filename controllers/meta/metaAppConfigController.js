// controllers/meta/metaAppConfigController.js
//
// Config central das credenciais de App do Meta (compartilhadas WhatsApp + Lead
// Ads). Admin-only via middlewares do router. O teste valida o par App ID +
// App Secret via client_credentials grant (gera um app access token).

import axios from 'axios';
import jwt from 'jsonwebtoken';
import MetaAppConfigService from '../../services/meta/MetaAppConfigService.js';
import MetaCampaignsTokenService from '../../services/meta/MetaCampaignsTokenService.js';

// Redirect do OAuth de campanhas. Precisa estar cadastrado no App
// (Facebook Login → URIs de redirecionamento OAuth válidos).
const CAMPAIGNS_OAUTH_REDIRECT = process.env.META_OAUTH_REDIRECT_URI
    || 'https://menin.up.railway.app/api/meta-app-oauth/campaigns/callback';

export async function getConfig(req, res) {
    try {
        const config = await MetaAppConfigService.getConfig({ useCache: false });
        return res.json({ ok: true, config });
    } catch (err) {
        console.error(`❌ [meta-app] get: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao carregar a configuração do App Meta.' });
    }
}

export async function updateConfig(req, res) {
    try {
        const updated = await MetaAppConfigService.updateConfig(req.body || {});
        return res.json({ ok: true, config: updated });
    } catch (err) {
        console.error(`❌ [meta-app] update: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao salvar a configuração do App Meta.' });
    }
}

/**
 * Testa App ID + App Secret via client_credentials (gera um app access token).
 * Se a Meta devolve o token, o par está correto. É o teste que pega justamente
 * o segredo dessincronizado que derruba os webhooks.
 */
export async function testAppSecret(req, res) {
    try {
        const cfg = await MetaAppConfigService.getConfig({ withSecrets: true, useCache: false });
        const appId = cfg?.meta_app_id;
        const appSecret = cfg?.meta_app_secret;
        const version = cfg?.meta_graph_api_version || 'v21.0';

        if (!appId || !appSecret) {
            return res.status(400).json({
                ok: false,
                error: 'Preencha o App ID e o App Secret e salve antes de testar.',
            });
        }

        try {
            const r = await axios.get(`https://graph.facebook.com/${version}/oauth/access_token`, {
                params: { client_id: appId, client_secret: appSecret, grant_type: 'client_credentials' },
                timeout: 15000,
            });
            const valid = !!r.data?.access_token;
            await MetaAppConfigService.recordTest({ ok: valid, error: valid ? null : 'resposta sem access_token' });
            return res.json({
                ok: valid,
                app_id: appId,
                hint: valid
                    ? 'App ID + App Secret válidos. WhatsApp e Lead Ads usam este mesmo segredo.'
                    : 'A Meta respondeu sem token — confira o App ID e o App Secret.',
            });
        } catch (err) {
            const detail = err?.response?.data?.error?.message || err.message;
            await MetaAppConfigService.recordTest({ ok: false, error: detail });
            return res.json({
                ok: false,
                error: detail,
                hint: 'App ID e App Secret não batem. Pegue o segredo atual em developers.facebook.com → seu App → Configurações → Básico → App Secret.',
            });
        }
    } catch (err) {
        console.error(`❌ [meta-app] testAppSecret: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao testar o App Secret.' });
    }
}

// ── Token de gestão de campanhas ─────────────────────────────────────────────

export async function campaignsStatus(req, res) {
    try {
        const st = await MetaCampaignsTokenService.status({ liveCount: true });
        return res.json({ ok: true, status: st });
    } catch (err) {
        console.error(`❌ [meta-app] campaignsStatus: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao ler o status do token de campanhas.' });
    }
}

export async function connectCampaigns(req, res) {
    try {
        const token = (req.body?.token || '').trim();
        if (!token) return res.status(400).json({ ok: false, error: 'Cole o token de acesso admin.' });
        const result = await MetaCampaignsTokenService.connectFromToken(token);
        return res.json({ ok: true, ...result });
    } catch (err) {
        const detail = err?.response?.data?.error?.message || err.message;
        console.error(`❌ [meta-app] connectCampaigns: ${detail}`);
        return res.status(400).json({ ok: false, error: detail });
    }
}

export async function refreshCampaigns(req, res) {
    try {
        const r = await MetaCampaignsTokenService.refresh();
        return res.json({ ok: r.refreshed !== false, ...r });
    } catch (err) {
        console.error(`❌ [meta-app] refreshCampaigns: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

export async function disconnectCampaigns(req, res) {
    try {
        await MetaCampaignsTokenService.disconnect();
        return res.json({ ok: true });
    } catch (err) {
        console.error(`❌ [meta-app] disconnectCampaigns: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

/** Gera a URL do login OAuth com um `state` assinado (JWT). */
export async function campaignsOAuthUrl(req, res) {
    try {
        const secret = process.env.JWT_SECRET;
        if (!secret) return res.status(500).json({ ok: false, error: 'JWT_SECRET ausente no servidor.' });
        const state = jwt.sign({ p: 'meta_campaigns_oauth', uid: req.user?.id || null }, secret, { expiresIn: '10m' });
        const url = await MetaCampaignsTokenService.buildOAuthUrl({ redirectUri: CAMPAIGNS_OAUTH_REDIRECT, state });
        return res.json({ ok: true, url, redirect_uri: CAMPAIGNS_OAUTH_REDIRECT });
    } catch (err) {
        console.error(`❌ [meta-app] campaignsOAuthUrl: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

/**
 * Callback PÚBLICO do OAuth — a Meta redireciona o NAVEGADOR pra cá (sem o JWT
 * do app). Segurança via `state` assinado. Renderiza uma página simples.
 */
export async function campaignsOAuthCallback(req, res) {
    const page = (ok, msg) => res.status(ok ? 200 : 400).send(oauthHtml(ok, msg));
    try {
        const { code, state, error, error_description } = req.query;
        if (error) return page(false, error_description || String(error));
        if (!code || !state) return page(false, 'Parâmetros ausentes no callback.');
        try {
            jwt.verify(String(state), process.env.JWT_SECRET);
        } catch {
            return page(false, 'Sessão de conexão inválida ou expirada. Refaça pelo Office.');
        }
        const result = await MetaCampaignsTokenService.connectFromCode(String(code), CAMPAIGNS_OAUTH_REDIRECT);
        const extra = result.accounts_count != null ? ` ${result.accounts_count} contas de anúncio visíveis.` : '';
        return page(true, `Conectado como ${result.name || 'admin'}.${extra}`);
    } catch (err) {
        const detail = err?.response?.data?.error?.message || err.message;
        console.error(`❌ [meta-app] campaignsOAuthCallback: ${detail}`);
        return page(false, detail);
    }
}

function oauthHtml(ok, msg) {
    const color = ok ? '#16a34a' : '#dc2626';
    const title = ok ? '✅ Campanhas conectadas' : '❌ Falha ao conectar';
    const safe = String(msg || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;color:#e5e7eb;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
<div style="max-width:440px;text-align:center;padding:32px;background:#111827;border:1px solid #1f2937;border-radius:16px">
<div style="font-size:20px;font-weight:600;color:${color};margin-bottom:10px">${title}</div>
<div style="font-size:14px;color:#9ca3af;line-height:1.5">${safe}</div>
<div style="font-size:12px;color:#6b7280;margin-top:18px">Pode fechar esta aba e voltar ao Office.</div>
</div>
<script>setTimeout(function(){try{window.close();}catch(e){}},2500);</script>
</body></html>`;
}

export default {
    getConfig, updateConfig, testAppSecret,
    campaignsStatus, connectCampaigns, refreshCampaigns, disconnectCampaigns,
    campaignsOAuthUrl, campaignsOAuthCallback,
};

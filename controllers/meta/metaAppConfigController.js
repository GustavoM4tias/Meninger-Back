// controllers/meta/metaAppConfigController.js
//
// Config central das credenciais de App do Meta (compartilhadas WhatsApp + Lead
// Ads). Admin-only via middlewares do router. O teste valida o par App ID +
// App Secret via client_credentials grant (gera um app access token).

import axios from 'axios';
import MetaAppConfigService from '../../services/meta/MetaAppConfigService.js';

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

export default { getConfig, updateConfig, testAppSecret };

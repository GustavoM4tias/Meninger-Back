// controllers/marketing/marketingConfigController.js
//
// Endpoints admin pra ler/atualizar a config singleton da captação, e pra
// testar a conexão com a Graph API do Meta. Tudo já admin-only via middlewares
// do router pai.

import axios from 'axios';
import MarketingConfigService from '../../services/marketing/MarketingConfigService.js';

const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || 'https://menin.up.railway.app';

export async function getConfig(req, res) {
    try {
        const cfg = await MarketingConfigService.getConfig({ useCache: false });
        return res.json({
            ok: true,
            config: cfg,
            webhook_url: `${PUBLIC_BACKEND_URL}/api/marketing/webhook/meta`,
        });
    } catch (err) {
        console.error(`❌ [marketing-config] get: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao carregar configurações.' });
    }
}

export async function updateConfig(req, res) {
    try {
        const updated = await MarketingConfigService.updateConfig(req.body || {});
        return res.json({ ok: true, config: updated });
    } catch (err) {
        console.error(`❌ [marketing-config] update: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao salvar configurações.' });
    }
}

// Gera um verify token aleatório (48 chars hex) — utilitário pra UI.
export async function generateVerifyToken(req, res) {
    try {
        const crypto = await import('crypto');
        const token = crypto.randomBytes(24).toString('hex');
        return res.json({ ok: true, token });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'Erro ao gerar token.' });
    }
}

/**
 * Testa o token do Meta:
 *  1. GET /me — confirma se o token é válido e retorna a identidade
 *  2. GET /me/accounts — lista Páginas que o token consegue acessar
 *
 * Retorna sucesso parcial: se /me passou mas /me/accounts não (típico de
 * token sem permissão pages_show_list), devolve identidade + hint.
 */
export async function testMetaConnection(req, res) {
    try {
        const cfg = await MarketingConfigService.getConfig({ withSecrets: true, useCache: false });
        const token = cfg.meta_access_token;
        const version = cfg.meta_graph_api_version || 'v21.0';

        if (!token) {
            return res.status(400).json({
                ok: false,
                error: 'Token de acesso do Meta não configurado. Preencha "Token de acesso (System User)" e salve antes de testar.',
            });
        }

        const base = `https://graph.facebook.com/${version}`;

        // Passo 1: identidade
        let identity;
        try {
            const r = await axios.get(`${base}/me`, {
                params: { access_token: token, fields: 'id,name' },
                timeout: 15000,
            });
            identity = r.data;
        } catch (err) {
            const detail = err?.response?.data?.error?.message || err.message;
            await MarketingConfigService.recordMetaHealth({ ok: false, error: `me: ${detail}` });
            return res.json({
                ok: false,
                step: 'identity',
                error: detail,
                hint: 'O token parece inválido ou expirado. Gere um novo no business.facebook.com → Configurações → Usuários do Sistema → Menin-Office → "Gerar token".',
            });
        }

        // Passo 2: Páginas
        let pages = [];
        let pagesError = null;
        try {
            const r = await axios.get(`${base}/me/accounts`, {
                params: { access_token: token, fields: 'id,name,access_token,tasks', limit: 100 },
                timeout: 15000,
            });
            pages = Array.isArray(r.data?.data) ? r.data.data.map(p => ({
                id: p.id,
                name: p.name,
                has_page_token: !!p.access_token,
                tasks: Array.isArray(p.tasks) ? p.tasks : [],
            })) : [];
        } catch (err) {
            pagesError = err?.response?.data?.error?.message || err.message;
        }

        const okFull = !!identity && !pagesError;
        await MarketingConfigService.recordMetaHealth({
            ok: okFull,
            error: pagesError ? `pages: ${pagesError}` : null,
            payload: { identity, pages_count: pages.length, pages_error: pagesError },
        });

        if (pagesError) {
            return res.json({
                ok: true,                       // identidade OK
                identity,
                pages: [],
                accounts_error: pagesError,
                hint: 'O token é válido mas não consegue listar Páginas. Adicione as permissões pages_show_list + pages_read_engagement + leads_retrieval ao gerar o token, e vincule a Página dos anúncios como ativo do System User.',
            });
        }

        return res.json({ ok: true, identity, pages });
    } catch (err) {
        console.error(`❌ [marketing-config] testMetaConnection: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao testar conexão.' });
    }
}

export default { getConfig, updateConfig, generateVerifyToken, testMetaConnection };

// services/meta/MetaCampaignsTokenService.js
//
// Token de GESTÃO DE CAMPANHAS do Meta — separado do token de leads.
//
// Problema que resolve: o token do System User (Menin-Office) só enxerga as
// contas de anúncio atribuídas a ele. Quando há várias Business Managers, cada
// conta nova precisa ser vinculada na mão. Um token de usuário ADMIN enxerga
// TODAS as contas de todos os BMs automaticamente (inclusive futuras).
//
// Desenho: este token é usado SÓ pelo sync de campanhas/ads (atribuição +
// relatório). Os LEADS continuam no System User (token permanente). Se este
// token expirar/cair, os leads NÃO param — só o relatório fica desatualizado
// até religar. Com refresh automático + alerta anti-expiração.

import axios from 'axios';
import db from '../../models/sequelize/index.js';
import MetaAppConfigService from './MetaAppConfigService.js';
import MarketingConfigService from '../marketing/MarketingConfigService.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';

const REFRESH_WINDOW_DAYS = 10;   // tenta renovar quando faltam <= 10 dias
const ALERT_WINDOW_DAYS   = 7;    // alerta admins quando faltam <= 7 dias e não deu pra renovar

// Escopos necessários pra ler campanhas/insights de todas as contas do admin.
export const CAMPAIGNS_OAUTH_SCOPES = ['ads_read', 'read_insights', 'business_management'];

const ALERT_THROTTLE_MS = 12 * 60 * 60 * 1000;   // no máx. 1 alerta / 12h (trava no banco)

let _lastExpiredWarnAt = 0;                      // só pra não poluir o log do sync

async function appCreds() {
    const cfg = await MetaAppConfigService.getConfig({ withSecrets: true, useCache: false });
    const appId = cfg?.meta_app_id;
    const appSecret = cfg?.meta_app_secret;
    const version = cfg?.meta_graph_api_version || 'v21.0';
    if (!appId || !appSecret) throw new Error('App ID / App Secret do Meta não configurados (defina em Configurações › Meta).');
    return { appId, appSecret, version, base: `https://graph.facebook.com/${version}`, appToken: `${appId}|${appSecret}` };
}

function daysUntil(date) {
    if (!date) return null;
    return Math.floor((new Date(date).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

/** Já venceu? (null/sem expiração = não). */
function isExpired(date) {
    return !!date && new Date(date).getTime() <= Date.now();
}

/** Troca um token de usuário por um de longa duração (~60 dias). */
async function exchangeLongLived(userToken, creds) {
    const r = await axios.get(`${creds.base}/oauth/access_token`, {
        params: {
            grant_type: 'fb_exchange_token',
            client_id: creds.appId,
            client_secret: creds.appSecret,
            fb_exchange_token: userToken,
        },
        timeout: 20000,
    });
    const token = r.data?.access_token;
    if (!token) throw new Error('A Meta não devolveu access_token na troca.');
    const expiresIn = Number(r.data?.expires_in) || 0;   // segundos; 0 = sem expiração informada
    const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null;
    return { token, expiresAt };
}

/** Inspeciona o token: user_id, nome e expiração real (expires_at=0 → nunca). */
async function inspect(token, creds) {
    const out = { userId: null, name: null, expiresAt: null, scopes: [] };
    try {
        const dbg = await axios.get(`${creds.base}/debug_token`, {
            params: { input_token: token, access_token: creds.appToken },
            timeout: 20000,
        });
        const d = dbg.data?.data || {};
        out.userId = d.user_id ? String(d.user_id) : null;
        out.scopes = Array.isArray(d.scopes) ? d.scopes : [];
        // expires_at em segundos epoch; 0 (ou ausente) = token sem expiração.
        if (d.expires_at && Number(d.expires_at) > 0) out.expiresAt = new Date(Number(d.expires_at) * 1000);
    } catch { /* debug_token pode falhar em alguns tokens — segue com o que der */ }
    try {
        const me = await axios.get(`${creds.base}/me`, {
            params: { access_token: token, fields: 'id,name' }, timeout: 20000,
        });
        out.name = me.data?.name || out.name;
        if (!out.userId && me.data?.id) out.userId = String(me.data.id);
    } catch { /* idem */ }
    return out;
}

/** Conta as contas de anúncio visíveis pelo token (pra mostrar no status). */
async function countAdAccounts(token, creds) {
    let count = 0;
    let url = `${creds.base}/me/adaccounts`;
    let params = { access_token: token, fields: 'id', limit: 200 };
    for (let i = 0; i < 5; i++) {
        const r = await axios.get(url, { params, timeout: 20000 });
        count += Array.isArray(r.data?.data) ? r.data.data.length : 0;
        const next = r.data?.paging?.next;
        if (!next) break;
        url = next; params = {};
    }
    return count;
}

/**
 * Conecta a partir de um token de usuário (curto ou longo). Normaliza pra
 * longa duração quando possível, inspeciona e grava. Robusto a token de System
 * User (não-trocável): nesse caso usa o token cru + expiração do debug_token.
 */
export async function connectFromToken(rawToken) {
    const token = String(rawToken || '').trim();
    if (!token) throw new Error('Token vazio.');
    const creds = await appCreds();

    let finalToken = token;
    let expiresAt = null;
    try {
        const ex = await exchangeLongLived(token, creds);
        finalToken = ex.token;
        expiresAt = ex.expiresAt;
    } catch {
        // Token não-trocável (ex.: System User) — segue com o cru; expiração vem do inspect.
    }

    const info = await inspect(finalToken, creds);
    if (info.expiresAt) expiresAt = info.expiresAt;   // debug_token é a fonte mais precisa

    await MetaAppConfigService.updateCampaignsToken({
        token: finalToken,
        expiresAt: expiresAt || null,
        connectedName: info.name || null,
        connectedId: info.userId || null,
    });
    await MetaAppConfigService.recordCampaignsRefresh({ ok: true, expiresAt: expiresAt || null });

    let accountsCount = null;
    try { accountsCount = await countAdAccounts(finalToken, creds); } catch { /* opcional */ }

    return {
        connected: true,
        name: info.name,
        expires_at: expiresAt,
        days_left: daysUntil(expiresAt),
        accounts_count: accountsCount,
        scopes: info.scopes,
    };
}

/** Troca um `code` do OAuth por token e conecta. */
export async function connectFromCode(code, redirectUri) {
    const creds = await appCreds();
    const r = await axios.get(`${creds.base}/oauth/access_token`, {
        params: {
            client_id: creds.appId,
            client_secret: creds.appSecret,
            redirect_uri: redirectUri,
            code,
        },
        timeout: 20000,
    });
    const shortToken = r.data?.access_token;
    if (!shortToken) throw new Error('A Meta não devolveu access_token no callback do OAuth.');
    return connectFromToken(shortToken);
}

/** Monta a URL do diálogo de OAuth (login com Facebook). */
export async function buildOAuthUrl({ redirectUri, state }) {
    const creds = await appCreds();
    const p = new URLSearchParams({
        client_id: creds.appId,
        redirect_uri: redirectUri,
        state,
        response_type: 'code',
        scope: CAMPAIGNS_OAUTH_SCOPES.join(','),
    });
    return `https://www.facebook.com/${creds.version}/dialog/oauth?${p.toString()}`;
}

/** Renova o token de longa duração (best-effort). */
export async function refresh() {
    const token = await MetaAppConfigService.getCampaignsToken();
    if (!token) return { refreshed: false, reason: 'sem token' };
    const creds = await appCreds();
    try {
        const ex = await exchangeLongLived(token, creds);
        const info = await inspect(ex.token, creds);
        const expiresAt = info.expiresAt || ex.expiresAt || null;
        await MetaAppConfigService.updateCampaignsToken({
            token: ex.token, expiresAt,
            connectedName: info.name || undefined, connectedId: info.userId || undefined,
        });
        await MetaAppConfigService.recordCampaignsRefresh({ ok: true, expiresAt });
        return { refreshed: true, expires_at: expiresAt, days_left: daysUntil(expiresAt) };
    } catch (e) {
        const detail = e?.response?.data?.error?.message || e.message;
        await MetaAppConfigService.recordCampaignsRefresh({ ok: false, error: detail });
        return { refreshed: false, reason: detail };
    }
}

/** Desconecta (remove o token). O sync volta a usar o System User (fallback). */
export async function disconnect() {
    await MetaAppConfigService.updateCampaignsToken({ token: '__CLEAR__' });
    return { connected: false };
}

/** Status pra UI (sem expor o token). liveCount=true faz 1 chamada extra à Meta. */
export async function status({ liveCount = false } = {}) {
    const cfg = await MetaAppConfigService.getConfig({ useCache: false });
    const connected = !!cfg?.has_meta_campaigns_token;
    const expiresAt = cfg?.meta_campaigns_token_expires_at || null;
    const out = {
        connected,
        name: cfg?.meta_campaigns_connected_name || null,
        expires_at: expiresAt,
        days_left: daysUntil(expiresAt),
        last_refresh_at: cfg?.meta_campaigns_last_refresh_at || null,
        last_refresh_ok: cfg?.meta_campaigns_last_refresh_ok ?? null,
        last_refresh_error: cfg?.meta_campaigns_last_refresh_error || null,
        // Token vencido continua gravado, mas não vale nada: o sync o ignora e
        // cai no System User. A UI precisa disso pra não pintar de verde.
        expired: connected && isExpired(expiresAt),
        accounts_count: null,
    };
    if (connected && !out.expired && liveCount) {
        try {
            const token = await MetaAppConfigService.getCampaignsToken();
            const creds = await appCreds();
            out.accounts_count = await countAdAccounts(token, creds);
        } catch (e) {
            out.count_error = e?.response?.data?.error?.message || e.message;
        }
    }
    return out;
}

/**
 * Credenciais pro sync de campanhas/ads. Retorna null se não há token de
 * campanhas configurado → o chamador cai no fallback (token do System User),
 * preservando o comportamento atual.
 */
export async function getCreds() {
    const cfg = await MetaAppConfigService.getConfig({ withSecrets: true, useCache: false });
    const token = cfg?.meta_campaigns_token;
    if (!token) return null;

    // Token vencido é PIOR que token nenhum: com ele todas as chamadas do sync
    // voltam erro 190 e o relatório inteiro morre, em vez de degradar pro System
    // User (que enxerga menos contas, mas enxerga). Trata como não configurado.
    if (isExpired(cfg.meta_campaigns_token_expires_at)) {
        if (Date.now() - _lastExpiredWarnAt >= 60 * 60 * 1000) {
            _lastExpiredWarnAt = Date.now();
            console.warn('⚠️  [meta-campaigns-token] token expirado — sync usando o System User até reconectar.');
        }
        return null;
    }

    const version = cfg.meta_graph_api_version || 'v21.0';
    return { token, version, base: `https://graph.facebook.com/${version}` };
}

/**
 * Chamado pelo scheduler (full sync): renova o token se estiver perto de expirar
 * e alerta os admins enquanto ainda dá tempo de reconectar. No-op se não há
 * token de campanhas. Nunca lança (best-effort).
 *
 * Regra do alerta: olha a expiração RESULTANTE, não o sucesso da renovação. A
 * Meta responde 200 ao trocar um token que já é de longa duração e devolve a
 * MESMA data de expiração — "renovou" sem ganhar um dia. Alertar só no erro da
 * troca foi o que matou o token calado em 04/09/2026: o primeiro aviso saiu 2h
 * DEPOIS de ele já estar vencido, e aí não havia mais o que renovar (token
 * expirado só volta com login de novo).
 */
export async function maybeRefreshAndAlert() {
    try {
        const cfg = await MetaAppConfigService.getConfig({ useCache: false });
        if (!cfg?.has_meta_campaigns_token) return;         // não configurado → nada a fazer
        const expiresAt = cfg.meta_campaigns_token_expires_at;
        if (!expiresAt) return;                              // sem expiração conhecida (ex.: System User) → nada a fazer
        const left = daysUntil(expiresAt);
        if (left == null || left > REFRESH_WINDOW_DAYS) return;

        // Token vencido não tem renovação possível; só gasta chamada e enche o
        // log de erro. Pula direto pro alerta.
        const res = isExpired(expiresAt) ? { refreshed: false, reason: 'token expirado' } : await refresh();

        const after = await MetaAppConfigService.getConfig({ useCache: false });
        const leftAfter = daysUntil(after?.meta_campaigns_token_expires_at) ?? left;

        if (res.refreshed && leftAfter > ALERT_WINDOW_DAYS) {
            console.log(`✅ [meta-campaigns-token] renovado; expira em ${leftAfter} dias.`);
            return;
        }
        if (leftAfter > ALERT_WINDOW_DAYS) {
            console.warn(`⚠️  [meta-campaigns-token] não renovou (${res.reason}); ainda faltam ${leftAfter} dias.`);
            return;
        }

        // Dentro da janela de aviso — renovando ou não, quem resolve é gente.
        if (!(await MetaAppConfigService.claimCampaignsAlert(ALERT_THROTTLE_MS))) return;

        const venceu = leftAfter < 0;
        const quando = new Date(after?.meta_campaigns_token_expires_at || expiresAt).toLocaleDateString('pt-BR');
        const body = venceu
            ? `O token de gestão de campanhas do Meta EXPIROU em ${quando} e não tem renovação possível: reconecte em Configurações › Meta ("Reconectar com Facebook"). Até lá o relatório de campanhas roda com o token do System User, que enxerga só as contas atribuídas a ele. (Os leads não são afetados.)`
            : `O token de gestão de campanhas do Meta expira em ${leftAfter} dia(s), em ${quando}, e a renovação automática não estende esse prazo. Reconecte em Configurações › Meta antes disso para o relatório de campanhas continuar completo. (Os leads não são afetados.)`;

        const userIds = await MarketingConfigService.getAlertRecipients();
        if (userIds.length) {
            await NotificationService.notify({
                type: NotificationType.META_CAMPAIGNS_TOKEN_EXPIRING,
                recipients: { users: userIds },
                title: venceu ? 'Token de campanhas do Meta expirou' : 'Token de campanhas do Meta expirando',
                body,
                link: '/settings/meta',
                importance: venceu ? 8 : 7,
            });
            console.warn(`🔔 [meta-campaigns-token] alerta enviado: ${venceu ? 'expirado' : `expira em ${leftAfter} dias`}.`);
        }
    } catch (e) {
        console.error('[meta-campaigns-token] maybeRefreshAndAlert falhou:', e.message);
    }
}

export default {
    connectFromToken, connectFromCode, buildOAuthUrl, refresh, disconnect,
    status, getCreds, maybeRefreshAndAlert, CAMPAIGNS_OAUTH_SCOPES,
};

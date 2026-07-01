// scripts/leadgen_webhook.js
//
// Diagnóstico + conserto da assinatura do webhook Lead Ads (campo `leadgen`).
// É o equivalente, pro Lead Ads, do que o WhatsAppService faz com subscribed_apps.
//
// Rodar de dentro de Meninger-Back:
//   node scripts/leadgen_webhook.js
//       -> só DIAGNÓSTICO (read-only): mostra assinatura do App, page token e
//          se a Página está inscrita no leadgen.
//   node scripts/leadgen_webhook.js --subscribe-page
//       -> inscreve a Página no campo leadgen (POST /{page}/subscribed_apps).
//   node scripts/leadgen_webhook.js --subscribe-app=https://HOST/api/marketing/webhook/meta
//       -> registra/renova o callback no nível do App (POST /{app}/subscriptions).
//
// Página alvo: 116348201447045 (Menin Engenharia). Override: LEADGEN_PAGE_ID.

import axios from 'axios';
import db from '../models/sequelize/index.js';
import MarketingConfigService from '../services/marketing/MarketingConfigService.js';

const TARGET_PAGE_ID = process.env.LEADGEN_PAGE_ID || '116348201447045';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valOf = (prefix) => {
    const a = args.find((x) => x.startsWith(prefix));
    return a ? a.slice(prefix.length) : null;
};
const gerr = (e) => e?.response?.data?.error?.message || e.message;

async function main() {
    const cfg = await MarketingConfigService.getConfig({ withSecrets: true, useCache: false });
    const ver = cfg.meta_graph_api_version || 'v21.0';
    const base = `https://graph.facebook.com/${ver}`;
    const appId = cfg.meta_app_id;
    const appSecret = cfg.meta_app_secret;
    const userToken = cfg.meta_access_token;   // System User token
    const verifyToken = cfg.meta_verify_token;

    console.log('── Config (banco) ───────────────────────────────');
    console.log(`Graph version : ${ver}`);
    console.log(`App ID        : ${appId || '(vazio)'}`);
    console.log(`App Secret    : ${appSecret ? 'presente' : 'AUSENTE'}`);
    console.log(`Access token  : ${userToken ? 'presente' : 'AUSENTE'}`);
    console.log(`Verify token  : ${verifyToken ? 'presente' : 'AUSENTE'}`);
    if (!appId || !appSecret || !userToken) {
        console.error('\n❌ Faltam credenciais básicas (app id/secret/token). Aborta.');
        return;
    }
    const appToken = `${appId}|${appSecret}`;

    // 1) Assinatura no nível do App (callback URL + fields) ───────────────────
    console.log('\n── 1) App webhook (GET /{app}/subscriptions) ──────');
    try {
        const r = await axios.get(`${base}/${appId}/subscriptions`, {
            params: { access_token: appToken }, timeout: 20000,
        });
        const subs = r.data?.data || [];
        if (!subs.length) console.log('  (NENHUMA assinatura no App) ❌');
        for (const s of subs) {
            const fields = (s.fields || []).map((x) => x.name || x).join(', ');
            console.log(`  object=${s.object} active=${s.active}`);
            console.log(`    callback: ${s.callback_url}`);
            console.log(`    fields  : ${fields}`);
        }
    } catch (e) {
        console.error(`  ❌ erro: ${gerr(e)}`);
    }

    // 2) Page token via /me/accounts ─────────────────────────────────────────
    console.log('\n── 2) Páginas + Page Token (GET /me/accounts) ─────');
    let pageToken = null;
    try {
        const r = await axios.get(`${base}/me/accounts`, {
            params: { access_token: userToken, fields: 'id,name,access_token', limit: 200 },
            timeout: 20000,
        });
        const pages = r.data?.data || [];
        if (!pages.length) console.log('  (nenhuma página — token não é System User com acesso?) ❌');
        for (const p of pages) {
            const mark = String(p.id) === TARGET_PAGE_ID ? '  ← ALVO' : '';
            console.log(`  ${p.id}  ${p.name}  pageToken=${p.access_token ? 'sim' : 'NÃO'}${mark}`);
            if (String(p.id) === TARGET_PAGE_ID) pageToken = p.access_token;
        }
    } catch (e) {
        console.error(`  ❌ erro: ${gerr(e)}`);
    }

    // 3) Página inscrita no leadgen? (GET /{page}/subscribed_apps) ────────────
    console.log(`\n── 3) Página ${TARGET_PAGE_ID} inscrita? (GET subscribed_apps) ──`);
    if (pageToken) {
        try {
            const r = await axios.get(`${base}/${TARGET_PAGE_ID}/subscribed_apps`, {
                params: { access_token: pageToken }, timeout: 20000,
            });
            const apps = r.data?.data || [];
            if (!apps.length) console.log('  (nenhum app inscrito nesta Página) ❌');
            for (const a of apps) {
                console.log(`  app=${a.id || a.name}  fields: ${(a.subscribed_fields || []).join(', ')}`);
            }
            const target = apps.find((a) => String(a.id) === String(appId));
            const hasLeadgen = !!target && (target.subscribed_fields || []).includes('leadgen');
            console.log(`\n  → App ${appId} inscrito nesta Página? ${target ? 'sim' : 'NÃO ❌'}`);
            console.log(`  → leadgen assinado?               ${hasLeadgen ? 'SIM ✅' : 'NÃO ❌'}`);
        } catch (e) {
            console.error(`  ❌ erro: ${gerr(e)}`);
        }
    } else {
        console.log('  (sem Page Token — resolva o passo 2 antes)');
    }

    // ── CONSERTO: nível App (callback) ───────────────────────────────────────
    const cb = valOf('--subscribe-app=');
    if (cb) {
        console.log(`\n── CONSERTO: registrar callback no App → ${cb} ──`);
        if (!verifyToken) {
            console.error('  ❌ sem verify token — não dá.');
        } else {
            try {
                const r = await axios.post(`${base}/${appId}/subscriptions`, null, {
                    params: {
                        object: 'page', callback_url: cb, verify_token: verifyToken,
                        fields: 'leadgen', access_token: appToken,
                    },
                    timeout: 20000,
                });
                console.log('  resposta:', JSON.stringify(r.data));
                console.log('  ✅ enviado (a Meta faz o handshake GET no callback agora).');
            } catch (e) {
                console.error(`  ❌ erro: ${gerr(e)}`);
            }
        }
    }

    // ── CONSERTO: nível Página (subscribed_apps leadgen) ─────────────────────
    if (has('--subscribe-page')) {
        console.log(`\n── CONSERTO: inscrever Página ${TARGET_PAGE_ID} no leadgen ──`);
        if (!pageToken) {
            console.error('  ❌ sem Page Token — não dá.');
        } else {
            try {
                const r = await axios.post(`${base}/${TARGET_PAGE_ID}/subscribed_apps`, null, {
                    params: { subscribed_fields: 'leadgen', access_token: pageToken },
                    timeout: 20000,
                });
                console.log('  resposta:', JSON.stringify(r.data));
                console.log('  ✅ enviado. Rode sem flags pra confirmar (passo 3 = leadgen SIM).');
            } catch (e) {
                console.error(`  ❌ erro: ${gerr(e)}`);
            }
        }
    }

    console.log('\n── fim ──');
}

main()
    .catch((e) => { console.error('FATAL:', e.message); })
    .finally(async () => { try { await db.sequelize.close(); } catch { /* noop */ } process.exit(0); });

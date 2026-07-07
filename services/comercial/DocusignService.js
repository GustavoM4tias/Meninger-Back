// services/comercial/DocusignService.js
//
// Integração DocuSign eSignature para assinatura das Fichas Comerciais.
// Credenciais em docusign_settings (singleton, admin em /settings/docusign).
//
// DOIS modos de autenticação (o service escolhe sozinho):
//  1) SIMPLES — "Conectar com DocuSign" (Authorization Code + refresh token):
//     admin informa Integration Key + Secret Key, clica Conectar e loga no
//     DocuSign. O refresh token (rotativo) fica salvo e renova sozinho a cada
//     uso; se ficar ~30 dias sem uso, expira e basta clicar Conectar de novo.
//  2) AVANÇADO — JWT Grant (RSA): conexão de servidor que nunca expira.
//     Exige User ID + private key + consentimento one-time (consentUrl).
//
// Fluxo de assinatura: ficha autorizada → createEnvelope(html, assinantes) →
// DocuSign converte o HTML em PDF e roteia por e-mail → refresh() acompanha →
// completed → baixa o PDF combinado (com certificado) e salva no Supabase.

import jwt from 'jsonwebtoken';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import db from '../../models/sequelize/index.js';

const { DocusignSettings } = db;

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY
);
const BUCKET = process.env.SUPABASE_BUCKET || 'Office Bucket';

// Cache do token JWT (modo avançado; o modo OAuth persiste no banco).
let jwtTokenCache = { token: null, exp: 0, key: null };

async function getSettings() {
    let s = await DocusignSettings.findOne({ where: { id: 1 } });
    if (!s) s = await DocusignSettings.create({ id: 1 });
    return s;
}

function basicAuth(s) {
    return Buffer.from(`${s.integration_key}:${s.secret_key}`).toString('base64');
}

export async function isConfigured() {
    const s = await getSettings();
    const oauthReady = !!(s.refresh_token && s.account_id);
    const jwtReady = !!(s.integration_key && s.ds_user_id && s.account_id && s.private_key);
    return oauthReady || jwtReady;
}

// ─── Modo SIMPLES: Authorization Code ("Conectar com DocuSign") ───────────────

// URL de login do DocuSign (admin é redirecionado para cá).
export async function getAuthorizeUrl(state, redirectUri) {
    const s = await getSettings();
    if (!s.integration_key || !s.secret_key) {
        throw new Error('Informe e salve a Integration Key e a Secret Key primeiro.');
    }
    const q = new URLSearchParams({
        response_type: 'code',
        scope: 'signature',
        client_id: s.integration_key,
        redirect_uri: redirectUri,
        state,
    });
    return `https://${s.oauth_base}/oauth/auth?${q}`;
}

// Troca o code por tokens, descobre a conta default e salva TUDO (fica conectado).
export async function connectWithCode(code) {
    const s = await getSettings();
    const { data } = await axios.post(
        `https://${s.oauth_base}/oauth/token`,
        new URLSearchParams({ grant_type: 'authorization_code', code }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basicAuth(s)}` } }
    );

    // Descobre usuário + conta default (auto-preenche account_id e base_uri).
    const { data: info } = await axios.get(`https://${s.oauth_base}/oauth/userinfo`, {
        headers: { Authorization: `Bearer ${data.access_token}` },
    });
    const accounts = info?.accounts ?? [];
    const acct = accounts.find(a => a.is_default) || accounts[0];
    if (!acct) throw new Error('Nenhuma conta DocuSign disponível para este usuário.');

    await s.update({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        token_expires_at: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
        connected_email: info?.email ?? null,
        connected_name: info?.name ?? null,
        account_id: acct.account_id,
        base_uri: acct.base_uri,
        last_test_at: new Date(),
        last_test_ok: true,
    });

    return { email: info?.email, name: info?.name, account_id: acct.account_id };
}

export async function disconnect() {
    const s = await getSettings();
    await s.update({
        access_token: null, refresh_token: null, token_expires_at: null,
        connected_email: null, connected_name: null,
    });
}

// Renova o access token via refresh token (ROTATIVO: salva o novo refresh).
async function refreshOauthToken(s) {
    try {
        const { data } = await axios.post(
            `https://${s.oauth_base}/oauth/token`,
            new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refresh_token }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basicAuth(s)}` } }
        );
        await s.update({
            access_token: data.access_token,
            refresh_token: data.refresh_token ?? s.refresh_token,
            token_expires_at: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
        });
        return data.access_token;
    } catch (e) {
        const err = e.response?.data?.error;
        if (err === 'invalid_grant') {
            // Refresh expirou (>30 dias sem uso) ou foi revogado — exige novo login.
            await s.update({ access_token: null, refresh_token: null, token_expires_at: null });
            throw new Error('A conexão com o DocuSign expirou. Abra Configurações → DocuSign e clique em "Conectar com DocuSign" novamente.');
        }
        throw new Error(`DocuSign refresh falhou: ${e.response?.data?.error_description || err || e.message}`);
    }
}

// ─── Modo AVANÇADO: JWT Grant ─────────────────────────────────────────────────

export async function consentUrl() {
    const s = await getSettings();
    if (!s.integration_key) throw new Error('Configure a Integration Key primeiro.');
    const redirect = encodeURIComponent('https://developers.docusign.com/platform/auth/consent');
    return `https://${s.oauth_base}/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=${s.integration_key}&redirect_uri=${redirect}`;
}

async function getJwtToken(s) {
    const key = `${s.integration_key}|${s.ds_user_id}|${s.oauth_base}`;
    const now = Math.floor(Date.now() / 1000);
    if (jwtTokenCache.token && jwtTokenCache.key === key && jwtTokenCache.exp - 60 > now) {
        return jwtTokenCache.token;
    }

    const assertion = jwt.sign({
        iss: s.integration_key,
        sub: s.ds_user_id,
        aud: s.oauth_base,
        iat: now,
        exp: now + 3500,
        scope: 'signature impersonation',
    }, s.private_key, { algorithm: 'RS256' });

    try {
        const { data } = await axios.post(
            `https://${s.oauth_base}/oauth/token`,
            new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion,
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        jwtTokenCache = { token: data.access_token, exp: now + (data.expires_in ?? 3600), key };
        return data.access_token;
    } catch (e) {
        const body = e.response?.data;
        if (body?.error === 'consent_required') {
            throw new Error('DocuSign: consentimento pendente. Abra a URL de consentimento (modo avançado) logado no DocuSign e aprove o app.');
        }
        throw new Error(`DocuSign token (JWT) falhou: ${body?.error_description || body?.error || e.message}`);
    }
}

// ─── Token unificado + client da API ──────────────────────────────────────────

async function getAccessToken() {
    const s = await getSettings();

    // 1) Modo simples (login): renova sozinho pelo refresh token.
    if (s.refresh_token) {
        const validUntil = s.token_expires_at ? new Date(s.token_expires_at).getTime() : 0;
        if (s.access_token && validUntil - 60000 > Date.now()) return s.access_token;
        return await refreshOauthToken(s);
    }

    // 2) Modo avançado (JWT).
    if (s.integration_key && s.ds_user_id && s.private_key) {
        return await getJwtToken(s);
    }

    throw new Error('DocuSign não conectado. Abra Configurações → DocuSign e clique em "Conectar com DocuSign".');
}

async function getApiBase() {
    const s = await getSettings();

    // base_uri salvo no connect (modo simples) — caminho direto.
    if (s.base_uri && s.account_id) {
        return `${s.base_uri}/restapi/v2.1/accounts/${s.account_id}`;
    }

    // Modo JWT: descobre via userinfo.
    const token = await getAccessToken();
    const { data } = await axios.get(`https://${s.oauth_base}/oauth/userinfo`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const accounts = data?.accounts ?? [];
    const acct = accounts.find(a => a.account_id === s.account_id) || accounts.find(a => a.is_default) || accounts[0];
    if (!acct) throw new Error('DocuSign: nenhuma conta disponível para este usuário.');

    await s.update({ base_uri: acct.base_uri, account_id: s.account_id || acct.account_id });
    return `${acct.base_uri}/restapi/v2.1/accounts/${s.account_id || acct.account_id}`;
}

async function api() {
    const token = await getAccessToken();
    const base = await getApiBase();
    return axios.create({
        baseURL: base,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 60000,
    });
}

// Testa a conexão (qualquer modo) e grava o resultado nas settings.
export async function testConnection(userId = null) {
    const s = await getSettings();
    try {
        jwtTokenCache = { token: null, exp: 0, key: null };
        await getApiBase();
        await s.update({ last_test_at: new Date(), last_test_ok: true, updated_by: userId });
        return { ok: true };
    } catch (e) {
        await s.update({ last_test_at: new Date(), last_test_ok: false, updated_by: userId });
        return { ok: false, error: e.message };
    }
}

// ─── Envelopes ────────────────────────────────────────────────────────────────

// Página de assinaturas anexada ao fim do documento (placement 'final'):
// âncoras invisíveis /sigN/ (+ /iniN/ p/ rubrica) posicionam os campos do DocuSign.
function buildSignaturePage(signers, requireInitials, subject) {
    const blocks = signers.map((sg, i) => `
        <div style="margin-top:64px;">
            <span style="color:#ffffff;font-size:8px;">/sig${i + 1}/</span>
            ${requireInitials ? `<span style="color:#ffffff;font-size:8px;margin-left:220px;">/ini${i + 1}/</span>` : ''}
            <div style="border-top:1px solid #111827;width:360px;margin-top:44px;padding-top:6px;">
                <strong style="font-size:13px;">${escapeHtml(sg.name || '')}</strong><br/>
                <span style="font-size:11px;color:#4b5563;">${escapeHtml(sg.email || '')}</span>
            </div>
        </div>`).join('');

    return `
    <div style="page-break-before:always;padding:48px 40px;font-family:Arial,Helvetica,sans-serif;">
        <h2 style="font-size:18px;margin:0 0 4px;">Assinaturas</h2>
        <p style="font-size:12px;color:#6b7280;margin:0 0 8px;">${escapeHtml(subject || 'Ficha Comercial')}</p>
        ${blocks}
    </div>`;
}

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

// Cria e ENVIA o envelope. signers: [{name, email, order}]. Retorna { envelopeId }.
export async function createEnvelope({ html, subject, signers, placement = 'final', requireInitials = false }) {
    if (!signers?.length) throw new Error('Configure ao menos 1 assinante nas configurações das fichas.');

    let documentHtml = html;
    if (placement === 'final') {
        const page = buildSignaturePage(signers, requireInitials, subject);
        documentHtml = html.includes('</body>')
            ? html.replace('</body>', `${page}</body>`)
            : html + page;
    }

    const recipients = signers.map((sg, i) => {
        const base = {
            email: sg.email,
            name: sg.name,
            recipientId: String(i + 1),
            routingOrder: String(sg.order ?? i + 1),
        };
        if (placement === 'final') {
            base.tabs = {
                signHereTabs: [{
                    anchorString: `/sig${i + 1}/`,
                    anchorUnits: 'pixels',
                    anchorXOffset: '0',
                    anchorYOffset: '4',
                    anchorIgnoreIfNotPresent: 'true',
                }],
                ...(requireInitials ? {
                    initialHereTabs: [{
                        anchorString: `/ini${i + 1}/`,
                        anchorUnits: 'pixels',
                        anchorXOffset: '0',
                        anchorYOffset: '4',
                        anchorIgnoreIfNotPresent: 'true',
                    }],
                } : {}),
            };
        }
        // placement 'livre': sem tabs → assinatura em formato livre (signer posiciona).
        return base;
    });

    const client = await api();
    const { data } = await client.post('/envelopes', {
        emailSubject: subject?.substring(0, 100) || 'Ficha Comercial para assinatura',
        documents: [{
            documentBase64: Buffer.from(documentHtml, 'utf8').toString('base64'),
            name: `${subject || 'Ficha Comercial'}.html`,
            fileExtension: 'html',
            documentId: '1',
        }],
        recipients: { signers: recipients },
        status: 'sent',
    });

    return { envelopeId: data.envelopeId };
}

// Status do envelope + status individual dos assinantes.
export async function getEnvelopeStatus(envelopeId) {
    const client = await api();
    const [{ data: env }, { data: rec }] = await Promise.all([
        client.get(`/envelopes/${envelopeId}`),
        client.get(`/envelopes/${envelopeId}/recipients`),
    ]);
    return {
        status: env.status,                                  // sent|delivered|completed|declined|voided
        completedDateTime: env.completedDateTime ?? null,
        voidedReason: env.voidedReason ?? null,
        signers: (rec.signers ?? []).map(s => ({
            name: s.name,
            email: s.email,
            order: Number(s.routingOrder) || null,
            status: s.status,                                // created|sent|delivered|completed|declined
            signed_at: s.signedDateTime ?? null,
        })),
    };
}

// PDF combinado (todas as páginas + certificado de conclusão).
export async function downloadCombinedPdf(envelopeId) {
    const client = await api();
    const { data } = await client.get(`/envelopes/${envelopeId}/documents/combined`, {
        params: { certificate: 'true' },
        responseType: 'arraybuffer',
    });
    return Buffer.from(data);
}

export async function voidEnvelope(envelopeId, reason = 'Cancelado pelo emissor') {
    const client = await api();
    await client.put(`/envelopes/${envelopeId}`, { status: 'voided', voidedReason: reason.substring(0, 200) });
}

// Salva o PDF assinado no Supabase (mesmo padrão do Boleto). Retorna { path, url }.
export async function uploadSignedPdf(buffer, conditionId, envelopeId) {
    const filePath = `conditions/signatures/${conditionId}/${envelopeId}.pdf`;
    const { error } = await supabase.storage
        .from(BUCKET)
        .upload(filePath, buffer, { contentType: 'application/pdf', upsert: true });
    if (error) throw new Error(`Supabase upload falhou: ${error.message}`);
    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(filePath);
    return { path: filePath, url: urlData?.publicUrl ?? null };
}

export default {
    isConfigured, consentUrl, testConnection,
    getAuthorizeUrl, connectWithCode, disconnect,
    createEnvelope, getEnvelopeStatus, downloadCombinedPdf, voidEnvelope, uploadSignedPdf,
};

// services/comercial/DocusignService.js
//
// Integração DocuSign eSignature (JWT Grant) para assinatura das Fichas Comerciais.
// Credenciais em docusign_settings (singleton, admin em /settings/docusign).
//
// Fluxo: ficha autorizada → createEnvelope(html, assinantes) → DocuSign converte o
// HTML em PDF e roteia por e-mail → refresh() acompanha status → completed →
// baixa o PDF combinado (com certificado) e salva no Supabase (padrão do Boleto).
//
// Consentimento (one-time): o admin abre a consentUrl() no navegador logado no
// DocuSign e aprova o app — sem isso o token JWT retorna consent_required.

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

// Cache do token (expira em ~1h; renova com folga) e do base_uri por conta.
let tokenCache = { token: null, exp: 0, key: null };
let baseUriCache = { uri: null, key: null };

async function getSettings() {
    let s = await DocusignSettings.findOne({ where: { id: 1 } });
    if (!s) s = await DocusignSettings.create({ id: 1 });
    return s;
}

function cacheKey(s) {
    return `${s.integration_key}|${s.ds_user_id}|${s.oauth_base}`;
}

export async function isConfigured() {
    const s = await getSettings();
    return !!(s.integration_key && s.ds_user_id && s.account_id && s.private_key);
}

// URL de consentimento one-time do app (admin abre logado no DocuSign).
export async function consentUrl() {
    const s = await getSettings();
    if (!s.integration_key) throw new Error('Configure a Integration Key primeiro.');
    const redirect = encodeURIComponent('https://developers.docusign.com/platform/auth/consent');
    return `https://${s.oauth_base}/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=${s.integration_key}&redirect_uri=${redirect}`;
}

async function getAccessToken() {
    const s = await getSettings();
    if (!(s.integration_key && s.ds_user_id && s.private_key)) {
        throw new Error('Integração DocuSign não configurada (Integration Key, User ID e Private Key).');
    }
    const key = cacheKey(s);
    const now = Math.floor(Date.now() / 1000);
    if (tokenCache.token && tokenCache.key === key && tokenCache.exp - 60 > now) {
        return tokenCache.token;
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
        tokenCache = { token: data.access_token, exp: now + (data.expires_in ?? 3600), key };
        return data.access_token;
    } catch (e) {
        const body = e.response?.data;
        if (body?.error === 'consent_required') {
            throw new Error('DocuSign: consentimento pendente. Abra a URL de consentimento (botão nas configurações) logado no DocuSign e aprove o app.');
        }
        throw new Error(`DocuSign token falhou: ${body?.error_description || body?.error || e.message}`);
    }
}

// base_uri da conta (via /oauth/userinfo) — ex.: https://na4.docusign.net
async function getApiBase() {
    const s = await getSettings();
    const key = cacheKey(s) + `|${s.account_id}`;
    if (baseUriCache.uri && baseUriCache.key === key) return baseUriCache.uri;

    const token = await getAccessToken();
    const { data } = await axios.get(`https://${s.oauth_base}/oauth/userinfo`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const accounts = data?.accounts ?? [];
    const acct = accounts.find(a => a.account_id === s.account_id) || accounts.find(a => a.is_default) || accounts[0];
    if (!acct) throw new Error('DocuSign: nenhuma conta disponível para este usuário.');

    const uri = `${acct.base_uri}/restapi/v2.1/accounts/${s.account_id || acct.account_id}`;
    baseUriCache = { uri, key };
    return uri;
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

// Testa credenciais (token + userinfo) e grava o resultado nas settings.
export async function testConnection(userId = null) {
    const s = await getSettings();
    try {
        tokenCache = { token: null, exp: 0, key: null };
        baseUriCache = { uri: null, key: null };
        await getApiBase();
        await s.update({ last_test_at: new Date(), last_test_ok: true, updated_by: userId });
        return { ok: true };
    } catch (e) {
        await s.update({ last_test_at: new Date(), last_test_ok: false, updated_by: userId });
        return { ok: false, error: e.message };
    }
}

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
    createEnvelope, getEnvelopeStatus, downloadCombinedPdf, voidEnvelope, uploadSignedPdf,
};

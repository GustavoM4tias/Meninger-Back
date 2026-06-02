// services/whatsapp/WhatsAppService.js
//
// Cliente HTTP da WhatsApp Cloud API (graph.facebook.com).
// Não persiste nada — quem persiste é o NotificationService / Webhook handler.
//
// Endpoints usados:
//   POST   /{api_version}/{phone_number_id}/messages       -> envio (template/text)
//   GET    /{api_version}/{waba_id}/message_templates       -> lista templates
//   GET    /{api_version}/{phone_number_id}                 -> health (verifica ID)

import axios from 'axios';
import WhatsAppConfigService from './WhatsAppConfigService.js';

const GRAPH_BASE = 'https://graph.facebook.com';

class CloudApiError extends Error {
    constructor(message, { status, code, details } = {}) {
        super(message);
        this.name = 'CloudApiError';
        this.status = status || null;
        this.code = code || null;
        this.details = details || null;
    }
}

function normalizePhone(phone) {
    if (!phone) return null;
    // remove tudo que não for dígito/+, depois remove o +
    const digits = String(phone).replace(/[^\d+]/g, '').replace(/^\+/, '');
    return digits || null;
}

async function getAxiosClient() {
    const cfg = await WhatsAppConfigService.getConfig({ withSecrets: true });
    if (!cfg?.access_token) {
        throw new CloudApiError('WhatsApp config sem access_token. Cadastre na tela /settings/whatsapp.', { code: 'NO_TOKEN' });
    }
    if (!cfg.phone_number_id) {
        throw new CloudApiError('WhatsApp config sem phone_number_id.', { code: 'NO_PHONE_ID' });
    }
    const client = axios.create({
        baseURL: `${GRAPH_BASE}/${cfg.api_version}`,
        headers: {
            Authorization: `Bearer ${cfg.access_token}`,
            'Content-Type': 'application/json',
        },
        timeout: 15000,
    });
    return { client, cfg };
}

/**
 * Envia mensagem template aprovada.
 * @param {object} params
 * @param {string} params.to            - telefone destino (E.164 sem +)
 * @param {string} params.templateName
 * @param {string} [params.language='pt_BR']
 * @param {string[]} [params.variables=[]] - valores em ordem ({{1}}, {{2}}, ...)
 * @param {object} [params.headerImage]  - { url } (opcional)
 * @returns {Promise<{ id: string, raw: object }>}
 */
async function sendTemplate({ to, templateName, language = 'pt_BR', variables = [], headerImage = null }) {
    const phone = normalizePhone(to);
    if (!phone) throw new CloudApiError('Telefone inválido', { code: 'BAD_PHONE' });
    if (!templateName) throw new CloudApiError('templateName é obrigatório', { code: 'NO_TEMPLATE' });

    const { client, cfg } = await getAxiosClient();

    // monta o componente "body" com os parâmetros (caso haja variáveis)
    const components = [];
    if (headerImage?.url) {
        components.push({
            type: 'header',
            parameters: [{ type: 'image', image: { link: headerImage.url } }],
        });
    }
    if (Array.isArray(variables) && variables.length) {
        components.push({
            type: 'body',
            parameters: variables.map(v => ({ type: 'text', text: String(v ?? '') })),
        });
    }

    const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'template',
        template: {
            name: templateName,
            language: { code: language },
            ...(components.length ? { components } : {}),
        },
    };

    try {
        const { data } = await client.post(`/${cfg.phone_number_id}/messages`, payload);
        const id = data?.messages?.[0]?.id || null;
        return { id, raw: data };
    } catch (err) {
        const apiErr = err.response?.data?.error;
        throw new CloudApiError(
            apiErr?.message || err.message || 'Falha no envio',
            { status: err.response?.status, code: apiErr?.code, details: err.response?.data }
        );
    }
}

/**
 * Envia texto livre — só funciona dentro da janela de 24h após uma msg do user.
 * Útil para o futuro fluxo de atendimento.
 */
async function sendText({ to, body, previewUrl = false }) {
    const phone = normalizePhone(to);
    if (!phone) throw new CloudApiError('Telefone inválido', { code: 'BAD_PHONE' });
    if (!body) throw new CloudApiError('body obrigatório', { code: 'NO_BODY' });

    const { client, cfg } = await getAxiosClient();
    try {
        const { data } = await client.post(`/${cfg.phone_number_id}/messages`, {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: phone,
            type: 'text',
            text: { body, preview_url: !!previewUrl },
        });
        return { id: data?.messages?.[0]?.id || null, raw: data };
    } catch (err) {
        const apiErr = err.response?.data?.error;
        throw new CloudApiError(
            apiErr?.message || err.message || 'Falha no envio',
            { status: err.response?.status, code: apiErr?.code, details: err.response?.data }
        );
    }
}

/**
 * Lista templates da conta WABA na Meta (paginado retornando até 200).
 * @returns {Promise<Array>}
 */
async function fetchTemplates() {
    const cfg = await WhatsAppConfigService.getConfig({ withSecrets: true });
    if (!cfg?.access_token) throw new CloudApiError('WhatsApp config sem access_token.', { code: 'NO_TOKEN' });
    if (!cfg.waba_id) throw new CloudApiError('WhatsApp config sem waba_id.', { code: 'NO_WABA' });

    const url = `${GRAPH_BASE}/${cfg.api_version}/${cfg.waba_id}/message_templates`;
    const all = [];
    let next = url;
    let safety = 5; // até ~500 templates

    while (next && safety-- > 0) {
        const { data } = await axios.get(next, {
            params: next === url ? { limit: 100, access_token: cfg.access_token } : undefined,
            timeout: 15000,
        });
        if (Array.isArray(data?.data)) all.push(...data.data);
        next = data?.paging?.next || null;
    }

    return all;
}

/**
 * Health check rápido — confirma se phone_number_id é alcançável.
 * @returns {Promise<{ ok: boolean, details?: object, error?: string }>}
 */
async function healthCheck() {
    try {
        const { client, cfg } = await getAxiosClient();
        const { data } = await client.get(`/${cfg.phone_number_id}`, {
            params: { fields: 'id,display_phone_number,verified_name,quality_rating' },
        });
        return { ok: true, details: data };
    } catch (err) {
        const apiErr = err.response?.data?.error;
        return { ok: false, error: apiErr?.message || err.message || 'Falha no health check' };
    }
}

/**
 * Registra o número na Cloud API. Necessário 1× depois de adicionar um número
 * novo à WABA. Cria a conta na Cloud API e define o PIN de 2FA.
 *
 * @param {object} params
 * @param {string} params.pin  - 6 dígitos (qualquer um — não tem validação semântica)
 */
async function registerPhoneNumber({ pin }) {
    if (!/^\d{6}$/.test(String(pin || ''))) {
        throw new CloudApiError('PIN deve ter exatamente 6 dígitos.', { code: 'BAD_PIN' });
    }
    const cfg = await WhatsAppConfigService.getConfig({ withSecrets: true });
    if (!cfg?.access_token) throw new CloudApiError('Sem access_token configurado.', { code: 'NO_TOKEN' });
    if (!cfg.phone_number_id) throw new CloudApiError('Sem phone_number_id configurado.', { code: 'NO_PHONE_ID' });

    const url = `${GRAPH_BASE}/${cfg.api_version}/${cfg.phone_number_id}/register`;
    try {
        const { data } = await axios.post(url, {
            messaging_product: 'whatsapp',
            pin: String(pin),
        }, {
            headers: {
                Authorization: `Bearer ${cfg.access_token}`,
                'Content-Type': 'application/json',
            },
            timeout: 15000,
        });
        return data;
    } catch (err) {
        const apiErr = err.response?.data?.error;
        throw new CloudApiError(
            apiErr?.error_user_msg || apiErr?.message || err.message || 'Falha ao registrar número',
            { status: err.response?.status, code: apiErr?.code, details: err.response?.data }
        );
    }
}

/**
 * Cria um novo template no lado da Meta (entra em IN_REVIEW e depois APPROVED/REJECTED).
 *
 * @param {object} params
 * @param {string} params.name        - slug do template (lowercase, snake_case): 'event_reminder_v1'
 * @param {string} params.category    - 'UTILITY' | 'MARKETING' | 'AUTHENTICATION'
 * @param {string} [params.language='pt_BR']
 * @param {string} params.body        - texto com {{1}}, {{2}}, ...
 * @param {string[]} [params.examples=[]]  - valores de exemplo para CADA variável (mesma ordem)
 * @param {string} [params.headerText]     - cabeçalho TEXT opcional
 * @param {string} [params.footerText]     - rodapé opcional (max 60 chars)
 * @param {Array<{text:string}>} [params.buttons=[]] - até 3 botões Quick Reply.
 *        Quando user toca, a Meta envia inbound com `button.text` = texto do botão.
 *        Exemplo: [{ text: 'SIM' }, { text: 'NÃO' }]
 * @returns {Promise<{ id: string, status: string, category: string }>}
 */
async function createTemplate({ name, category, language = 'pt_BR', body, examples = [], headerText, footerText, buttons = [] }) {
    if (!name) throw new CloudApiError('name é obrigatório', { code: 'NO_NAME' });
    if (!category) throw new CloudApiError('category é obrigatório', { code: 'NO_CATEGORY' });
    if (!body) throw new CloudApiError('body é obrigatório', { code: 'NO_BODY' });

    const cfg = await WhatsAppConfigService.getConfig({ withSecrets: true });
    if (!cfg?.access_token) throw new CloudApiError('Sem access_token configurado.', { code: 'NO_TOKEN' });
    if (!cfg.waba_id) throw new CloudApiError('Sem waba_id configurado.', { code: 'NO_WABA' });

    const components = [];

    if (headerText) {
        components.push({ type: 'HEADER', format: 'TEXT', text: headerText });
    }

    const bodyComp = { type: 'BODY', text: body };
    // Se houver variáveis no body, a Meta exige examples
    const varCount = (body.match(/\{\{\s*\d+\s*\}\}/g) || []).length;
    if (varCount > 0) {
        if (!Array.isArray(examples) || examples.length < varCount) {
            throw new CloudApiError(
                `Template tem ${varCount} variável(is) no corpo, mas foram passados ${examples.length} exemplo(s).`,
                { code: 'EXAMPLES_MISMATCH' }
            );
        }
        bodyComp.example = { body_text: [examples.slice(0, varCount).map(String)] };
    }
    components.push(bodyComp);

    if (footerText) {
        components.push({ type: 'FOOTER', text: footerText });
    }

    // Quick Reply buttons (até 3). Quando user toca, inbound chega com:
    //   - type: 'button', button: { text: 'SIM', payload: 'SIM' }
    //   - context.id = wamid da mensagem template — perfeito pra amarrar ao alerta
    if (Array.isArray(buttons) && buttons.length) {
        const valid = buttons.filter(b => b?.text).slice(0, 3);
        if (valid.length) {
            components.push({
                type: 'BUTTONS',
                buttons: valid.map(b => ({ type: 'QUICK_REPLY', text: String(b.text).slice(0, 25) })),
            });
        }
    }

    const url = `${GRAPH_BASE}/${cfg.api_version}/${cfg.waba_id}/message_templates`;

    try {
        const { data } = await axios.post(url, {
            name: String(name).toLowerCase().replace(/[^a-z0-9_]/g, '_'),
            category: String(category).toUpperCase(),
            language,
            components,
        }, {
            headers: {
                Authorization: `Bearer ${cfg.access_token}`,
                'Content-Type': 'application/json',
            },
            timeout: 20000,
        });
        return data;
    } catch (err) {
        const apiErr = err.response?.data?.error;
        throw new CloudApiError(
            apiErr?.error_user_msg || apiErr?.message || err.message || 'Falha ao criar template',
            { status: err.response?.status, code: apiErr?.code, details: err.response?.data }
        );
    }
}

/**
 * Remove um template na Meta (por nome — apaga todas as versões em todos os idiomas).
 */
async function deleteTemplate({ name }) {
    if (!name) throw new CloudApiError('name é obrigatório', { code: 'NO_NAME' });
    const cfg = await WhatsAppConfigService.getConfig({ withSecrets: true });
    if (!cfg?.access_token || !cfg?.waba_id) {
        throw new CloudApiError('Config incompleta.', { code: 'BAD_CONFIG' });
    }
    const url = `${GRAPH_BASE}/${cfg.api_version}/${cfg.waba_id}/message_templates`;
    try {
        const { data } = await axios.delete(url, {
            params: { name, access_token: cfg.access_token },
            timeout: 15000,
        });
        return data;
    } catch (err) {
        const apiErr = err.response?.data?.error;
        throw new CloudApiError(
            apiErr?.message || err.message,
            { status: err.response?.status, code: apiErr?.code, details: err.response?.data }
        );
    }
}

/**
 * Descobre a árvore de Business → WABAs → Phone Numbers a partir de um access_token
 * (System User token recomendado). Usado pelo Setup Wizard pra preencher tudo
 * automaticamente em vez de obrigar o admin a copiar 5 IDs do Meta Business.
 *
 * Retorna:
 * {
 *   user: { id, name },
 *   businesses: [
 *     { id, name, wabas: [
 *       { id, name, currency, phone_numbers: [
 *         { id, display_phone_number, verified_name, quality_rating }
 *       ]}
 *     ]}
 *   ]
 * }
 */
async function discoverFromToken({ accessToken, apiVersion = 'v21.0' } = {}) {
    if (!accessToken) throw new CloudApiError('access_token é obrigatório.', { code: 'NO_TOKEN' });

    const base = `${GRAPH_BASE}/${apiVersion}`;
    const auth = { Authorization: `Bearer ${accessToken}` };
    const opts = { headers: auth, timeout: 15000 };

    // 1) Confirma o token funcionando + identifica o user/system-user
    let me;
    try {
        const { data } = await axios.get(`${base}/me`, { ...opts, params: { fields: 'id,name' } });
        me = data;
    } catch (err) {
        const apiErr = err.response?.data?.error;
        throw new CloudApiError(
            `Token inválido ou sem permissões: ${apiErr?.message || err.message}`,
            { status: err.response?.status, code: apiErr?.code || 'INVALID_TOKEN', details: err.response?.data }
        );
    }

    // 2) Lista businesses que esse token enxerga (paginado)
    const businesses = [];
    let nextUrl = `${base}/me/businesses`;
    let nextParams = { fields: 'id,name', limit: 50 };
    let safety = 5;
    while (nextUrl && safety-- > 0) {
        try {
            const { data } = await axios.get(nextUrl, { ...opts, params: nextParams });
            if (Array.isArray(data?.data)) businesses.push(...data.data);
            nextUrl = data?.paging?.next || null;
            nextParams = undefined; // o "next" já vem com tudo
        } catch (err) {
            const apiErr = err.response?.data?.error;
            throw new CloudApiError(
                `Falha listando businesses: ${apiErr?.message || err.message}`,
                { status: err.response?.status, code: apiErr?.code || 'NO_BUSINESSES', details: err.response?.data }
            );
        }
    }

    // 3) Para cada Business, lista WABAs e seus phone_numbers
    for (const biz of businesses) {
        biz.wabas = [];
        try {
            const { data } = await axios.get(`${base}/${biz.id}/owned_whatsapp_business_accounts`, {
                ...opts,
                params: { fields: 'id,name,currency,timezone_id', limit: 50 },
            });
            const wabas = Array.isArray(data?.data) ? data.data : [];
            for (const w of wabas) {
                w.phone_numbers = [];
                try {
                    const { data: pn } = await axios.get(`${base}/${w.id}/phone_numbers`, {
                        ...opts,
                        params: { fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status', limit: 50 },
                    });
                    if (Array.isArray(pn?.data)) w.phone_numbers = pn.data;
                } catch {
                    // sem permissão pra phone_numbers desse WABA — segue
                }
            }
            biz.wabas = wabas;
        } catch {
            // sem permissão pra WABAs desse Business — segue silencioso
        }
    }

    return { user: me, businesses };
}

export default {
    sendTemplate,
    sendText,
    fetchTemplates,
    createTemplate,
    deleteTemplate,
    registerPhoneNumber,
    healthCheck,
    discoverFromToken,
    normalizePhone,
    CloudApiError,
};

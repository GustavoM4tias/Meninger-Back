// controllers/marketing/leadFormController.js
//
// Handler do endpoint público de submissão de formulário de captação de leads.

import db from '../../models/sequelize/index.js';
import { captureLead } from '../../services/marketing/LeadCaptureService.js';
import { honeypotTripped, validateLeadContact } from '../../services/marketing/leadAntiSpam.js';

const { LeadForm } = db;

// Chaves que mapeiam direto para colunas do inbound_lead.
const LEAD_FIELDS = [
    'nome', 'email', 'telefone', 'telefone_ddi', 'documento', 'documento_tipo',
    'sexo', 'renda_familiar', 'cep', 'endereco', 'numero', 'complemento',
    'bairro', 'cidade', 'estado',
];
const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
// Chaves de controle — não são dados do lead, não vão para extra_fields.
const CONTROL_KEYS = new Set([
    ...LEAD_FIELDS, ...UTM_FIELDS,
    '_hp', '_gotcha', 'website', 'homepage',
    'consent', 'consentimento', 'referrer', 'landing_url',
]);

function clientIp(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || req.socket?.remoteAddress || null;
}

export async function submitLeadForm(req, res) {
    try {
        const { slug } = req.params;
        const body = { ...(req.query || {}), ...(req.body || {}) };

        const form = await LeadForm.findOne({ where: { slug, active: true } });
        if (!form) {
            return res.status(404).json({ ok: false, error: 'Formulário não encontrado ou inativo.' });
        }

        // Dados do lead
        const data = {};
        for (const k of LEAD_FIELDS) {
            if (body[k] != null && String(body[k]).trim() !== '') data[k] = String(body[k]).trim();
        }
        // Campos extras (não mapeados a colunas) preservados em extra_fields.
        const extra = {};
        for (const [k, v] of Object.entries(body)) {
            if (!CONTROL_KEYS.has(k) && v != null && v !== '') extra[k] = v;
        }
        if (Object.keys(extra).length) data.extra_fields = extra;

        // Atribuição
        const attribution = {
            ip: clientIp(req),
            user_agent: req.headers['user-agent'] || null,
            referrer: body.referrer || req.headers['referer'] || req.headers['referrer'] || null,
            landing_url: body.landing_url || null,
        };
        for (const k of UTM_FIELDS) {
            if (body[k]) attribution[k] = String(body[k]).trim();
        }

        const binding = {
            bound_empreendimentos: form.bound_empreendimentos,
            midia_slug: form.midia_slug,
            cv_origem: form.cv_origem,
            tags: form.tags,
        };

        // ── Honeypot: bot. Registra como spam, devolve sucesso neutro ───────
        // (um bot não deve perceber que foi pego).
        if (honeypotTripped(body)) {
            await captureLead({
                channel: 'site_form', data, binding, attribution,
                rawPayload: body, sourceFormId: form.id,
                spam: true, spamReasons: ['honeypot'],
            });
            return res.status(200).json({ ok: true, ...(form.redirect_url ? { redirect: form.redirect_url } : {}) });
        }

        // ── Validação de contato: usuário legítimo precisa poder corrigir ──
        const contact = validateLeadContact({ email: data.email, telefone: data.telefone });
        if (!contact.ok) {
            return res.status(400).json({ ok: false, error: 'Informe um e-mail ou telefone válido.' });
        }

        // ── Campos obrigatórios do fields_config do formulário ─────────────
        if (Array.isArray(form.fields_config) && form.fields_config.length) {
            for (const fc of form.fields_config) {
                if (fc.enabled !== false && fc.required) {
                    const v = body[fc.key];
                    if (v == null || String(v).trim() === '') {
                        return res.status(400).json({ ok: false, error: `Por favor preencha: ${fc.label || fc.key}` });
                    }
                }
            }
        }

        // ── LGPD: consentimento ─────────────────────────────────────────────
        const consentGiven = body.consent === true || body.consent === 'true'
            || body.consentimento === true || body.consentimento === 'true';
        if (form.consent_required && !consentGiven) {
            return res.status(400).json({ ok: false, error: 'É necessário aceitar o termo de consentimento.' });
        }

        await captureLead({
            channel: 'site_form', data, binding, attribution,
            consent: consentGiven ? {
                consent_at: new Date(),
                consent_text_version: form.consent_text_version,
                consent_ip: attribution.ip,
            } : {},
            rawPayload: body,
            sourceFormId: form.id,
        });

        return res.status(200).json({ ok: true, ...(form.redirect_url ? { redirect: form.redirect_url } : {}) });
    } catch (err) {
        console.error(`❌ [marketing-capture] erro ao processar formulário: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao processar o cadastro.' });
    }
}

export default { submitLeadForm };

// services/marketing/MetaLeadAdsService.js
//
// Integração com o Meta Lead Ads:
//  - verifySignature:  valida o HMAC SHA-256 do webhook (X-Hub-Signature-256)
//  - verifyHandshake:  handshake GET de assinatura do webhook
//  - fetchLead:        busca os dados do lead na Graph API (GET /{leadgen_id})
//  - parseLeadFields:  mapeia o field_data do Meta para campos do inbound_lead
//  - processLeadgenPayload: orquestra entry → changes → captura
//
// O app Meta é o mesmo do WhatsApp (785502081163165); o webhook 'leadgen' é uma
// assinatura separada (objeto Page) com callback URL própria.

import crypto from 'crypto';
import axios from 'axios';
import db from '../../models/sequelize/index.js';
import { captureLead } from './LeadCaptureService.js';
import MarketingConfigService from './MarketingConfigService.js';
import MetaLeadFormService from './MetaLeadFormService.js';

// Lê config do banco (com fallback pro .env). Cache interno do service.
async function getMetaCfg() {
    try { return await MarketingConfigService.getConfig({ withSecrets: true }); }
    catch { return null; }
}

async function getGraphVersion() {
    const cfg = await getMetaCfg();
    return cfg?.meta_graph_api_version || process.env.META_GRAPH_API_VERSION || 'v21.0';
}

// ── Segurança ───────────────────────────────────────────────────────────────

/**
 * Valida o HMAC SHA-256 do header X-Hub-Signature-256.
 * Fail-closed: sem app_secret configurado, REJEITA — o endpoint cria leads que
 * vão ao CRM, não pode aceitar requisição não assinada.
 */
export async function verifySignature(rawBody, signatureHeader) {
    const cfg = await getMetaCfg();
    const secret = cfg?.meta_app_secret || process.env.META_APP_SECRET;
    if (!secret) {
        console.warn('⚠️  [marketing-capture] App Secret do Meta não configurado — webhook rejeitando até ser configurado.');
        return false;
    }
    if (!signatureHeader) return false;
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    try {
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
    } catch {
        return false;
    }
}

/**
 * Handshake GET do webhook (modo subscribe). Retorna o challenge se válido, ou
 * null se inválido.
 */
export async function verifyHandshake({ mode, token, challenge }) {
    const cfg = await getMetaCfg();
    const expected = cfg?.meta_verify_token || process.env.META_LEAD_WEBHOOK_VERIFY_TOKEN;
    if (mode !== 'subscribe' || !expected) return null;
    return token === expected ? String(challenge ?? '') : null;
}

// ── Graph API ───────────────────────────────────────────────────────────────

/**
 * Busca os dados de um lead pelo leadgen_id. O webhook só entrega o id — os
 * campos preenchidos vêm desta chamada.
 */
export async function fetchLead(leadgenId) {
    const cfg = await getMetaCfg();
    const token = cfg?.meta_access_token || process.env.META_LEAD_ADS_TOKEN;
    if (!token) throw new Error('Token de acesso do Meta não configurado — não é possível buscar o lead.');
    const version = cfg?.meta_graph_api_version || process.env.META_GRAPH_API_VERSION || 'v21.0';
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(leadgenId)}`;
    const params = {
        access_token: token,
        fields: 'id,created_time,field_data,ad_id,form_id,campaign_id,platform',
    };
    // appsecret_proof — exigido quando o app tem "Exigir chave secreta" ligado;
    // é aceito sempre, então enviamos sempre que houver o secret configurado.
    const secret = cfg?.meta_app_secret || process.env.META_APP_SECRET;
    if (secret) {
        params.appsecret_proof = crypto.createHmac('sha256', secret).update(token).digest('hex');
    }
    const res = await axios.get(url, { params, timeout: 20000 });
    return res.data || {};
}

// ── Mapeamento de campos ────────────────────────────────────────────────────

const norm = s => String(s || '').trim().toLowerCase();

function pickField(fd, ...names) {
    const wanted = names.map(norm);
    for (const f of fd) {
        if (wanted.includes(norm(f?.name)) && Array.isArray(f?.values) && f.values.length) {
            return String(f.values[0]).trim();
        }
    }
    return null;
}

/**
 * Mapeia o field_data do Meta para os campos do inbound_lead. Campos padrão vão
 * para colunas; TODOS os campos (inclusive perguntas personalizadas) são
 * preservados em extra_fields.
 */
export function parseLeadFields(fieldData = []) {
    const fd = Array.isArray(fieldData) ? fieldData : [];
    const data = {
        email:    pickField(fd, 'email'),
        telefone: pickField(fd, 'phone_number', 'phone'),
        nome:     pickField(fd, 'full_name'),
        cidade:   pickField(fd, 'city'),
        estado:   pickField(fd, 'state', 'province'),
        endereco: pickField(fd, 'street_address'),
        cep:      pickField(fd, 'post_code', 'zip_code', 'postal_code'),
    };
    if (!data.nome) {
        const first = pickField(fd, 'first_name');
        const last = pickField(fd, 'last_name');
        if (first || last) data.nome = [first, last].filter(Boolean).join(' ');
    }
    // Preserva tudo — perguntas personalizadas (CPF, empreendimento de interesse...).
    const extra = {};
    for (const f of fd) {
        if (!f?.name) continue;
        const vals = Array.isArray(f.values) ? f.values : [];
        extra[f.name] = vals.length === 1 ? vals[0] : vals;
    }
    if (Object.keys(extra).length) data.extra_fields = extra;

    for (const k of Object.keys(data)) if (data[k] == null) delete data[k];
    return data;
}

// ── Processamento do payload ────────────────────────────────────────────────

async function processOneLead(value) {
    const leadgenId = value?.leadgen_id;
    if (!leadgenId) return;

    // Idempotência: o Meta pode reenviar o mesmo evento.
    const already = await db.InboundLead.findOne({
        where: { meta_leadgen_id: String(leadgenId) },
        attributes: ['id'],
    });
    if (already) {
        console.log(`ℹ️  [marketing-capture] leadgen ${leadgenId} já capturado — ignorado.`);
        return;
    }

    const graphLead = await fetchLead(leadgenId);
    const data = parseLeadFields(graphLead.field_data || []);

    const platform = norm(graphLead.platform);
    const platformOrigem = (platform === 'ig' || platform === 'instagram') ? 'IG' : 'FB';

    const formId = value.form_id != null
        ? String(value.form_id)
        : (graphLead.form_id != null ? String(graphLead.form_id) : null);

    // ── Mapping local do form (definido pelo admin em Marketing > Formulários > Meta).
    // Se mapping_active + midia_slug configurados, lead vira 'routed' direto.
    // Caso contrário (sem mapping ou inativo), só cv_origem vai no binding e
    // o lead cai em 'held' pra roteamento manual.
    const binding = { cv_origem: platformOrigem };
    if (formId) {
        try {
            const mapping = await MetaLeadFormService.findById(formId);
            if (mapping?.mapping_active && mapping.midia_slug) {
                binding.bound_empreendimentos = mapping.bound_empreendimentos || null;
                binding.midia_slug = mapping.midia_slug;
                binding.tags = mapping.tags || null;
                if (mapping.cv_origem) binding.cv_origem = mapping.cv_origem;
                console.log(`🔗 [marketing-capture] mapping aplicado ao lead Meta ${leadgenId} (form ${formId} → ${mapping.midia_slug}).`);
            } else if (mapping && !mapping.mapping_active) {
                console.log(`⏸️  [marketing-capture] mapping do form ${formId} desativado — lead ${leadgenId} ficará em 'held'.`);
            }
        } catch (e) {
            // Não bloqueia a captura — só perde a otimização do mapping.
            console.warn(`⚠️  [marketing-capture] falha ao consultar mapping do form ${formId}: ${e.message}`);
        }
    }

    await captureLead({
        channel: 'meta_lead_ads',
        data,
        binding,
        meta: {
            leadgen_id:  String(leadgenId),
            form_id:     formId,
            page_id:     value.page_id != null ? String(value.page_id) : null,
            ad_id:       value.ad_id != null ? String(value.ad_id) : (graphLead.ad_id != null ? String(graphLead.ad_id) : null),
            campaign_id: graphLead.campaign_id != null ? String(graphLead.campaign_id) : null,
        },
        rawPayload: { webhook: value, graph: graphLead },
    });
    console.log(`✅ [marketing-capture] lead Meta ${leadgenId} capturado.`);
}

/**
 * Processa o payload inteiro do webhook (já parseado).
 * Estrutura: { object:'page', entry:[ { changes:[ { field:'leadgen', value:{...} } ] } ] }
 */
export async function processLeadgenPayload(payload) {
    if (!payload || payload.object !== 'page') return;
    for (const entry of (Array.isArray(payload.entry) ? payload.entry : [])) {
        for (const change of (Array.isArray(entry.changes) ? entry.changes : [])) {
            if (change?.field !== 'leadgen') continue;
            try {
                await processOneLead(change.value || {});
            } catch (err) {
                console.error(`❌ [marketing-capture] leadgen ${change?.value?.leadgen_id || '?'} erro: ${err.message}`);
            }
        }
    }
}

export default { verifySignature, verifyHandshake, fetchLead, parseLeadFields, processLeadgenPayload };

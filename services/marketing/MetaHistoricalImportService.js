// services/marketing/MetaHistoricalImportService.js
//
// Importa leads históricos da Meta pra dentro do nosso inbound_leads.
// Diferente da captura via webhook (LeadCaptureService.captureLead), esses
// leads entram com status='historical' — NÃO disparam pro CV, são só pra
// visibilidade no inbox de Captação.
//
// A Meta retém leads por ~90 dias. Pega todos os forms cacheados em
// meta_lead_forms + chama /{form-id}/leads pra cada um.

import axios from 'axios';
import db from '../../models/sequelize/index.js';
import MarketingConfigService from './MarketingConfigService.js';
import { parseLeadFields } from './MetaLeadAdsService.js';
import { normalizeEmail, normalizePhone } from './leadAntiSpam.js';
import { recordLeadEvent } from './leadEventLog.js';

const { InboundLead, MetaLeadForm } = db;

async function getCreds() {
    const cfg = await MarketingConfigService.getConfig({ withSecrets: true, useCache: false });
    const token = cfg.meta_access_token;
    const version = cfg.meta_graph_api_version || 'v21.0';
    if (!token) throw new Error('Token de acesso do Meta não configurado.');
    return { token, version, base: `https://graph.facebook.com/${version}` };
}

/**
 * Carrega os Page Access Tokens via /me/accounts. /{form-id}/leads exige Page
 * Access Token específico (mesma regra do /{page-id}/leadgen_forms — erro #190 /
 * "Invalid appsecret_proof" quando se usa token errado aqui).
 */
async function fetchPageTokens({ token, base }) {
    const r = await axios.get(`${base}/me/accounts`, {
        params: { access_token: token, fields: 'id,name,access_token', limit: 100 },
        timeout: 20000,
    });
    const map = new Map();
    for (const p of (r.data?.data || [])) {
        if (p?.id && p?.access_token) map.set(String(p.id), p.access_token);
    }
    return map;
}

/**
 * Busca leads de um form usando o Page Access Token da Página dona do form.
 * Sem appsecret_proof — o proof depende do token, e Meta valida estritamente.
 */
async function fetchLeadsForForm({ base }, formId, pageAccessToken, { since = null } = {}) {
    if (!pageAccessToken) {
        throw new Error('Sem Page Access Token — verifique se a Página está atribuída ao System User.');
    }
    const all = [];
    let url = `${base}/${formId}/leads`;
    let params = {
        access_token: pageAccessToken,
        fields: 'id,created_time,field_data,ad_id,campaign_id,platform,form_id,is_organic',
        limit: 200,
    };
    if (since) {
        params.filtering = JSON.stringify([{
            field: 'time_created',
            operator: 'GREATER_THAN',
            value: Math.floor(since.getTime() / 1000),
        }]);
    }

    for (let i = 0; i < 50; i++) {
        const r = await axios.get(url, { params, timeout: 30000 });
        const data = Array.isArray(r.data?.data) ? r.data.data : [];
        all.push(...data);
        const next = r.data?.paging?.next;
        if (!next) break;
        url = next; params = {};
    }
    return all;
}

/**
 * Cria registro no inbound_leads com status='historical'. Idempotente via
 * meta_leadgen_id (índice/check antes de inserir).
 *
 * Retorna 'inserted' | 'duplicate' | 'error'.
 */
async function insertHistoricalLead({ leadgenId, graphLead, mapping }) {
    // Idempotência — não duplica leads que já estão no nosso DB (vindos do
    // webhook ou de import anterior).
    const existing = await InboundLead.findOne({
        where: { meta_leadgen_id: String(leadgenId) },
        attributes: ['id'],
    });
    if (existing) return 'duplicate';

    const data = parseLeadFields(graphLead.field_data || []);
    const platform = String(graphLead.platform || '').toLowerCase();
    const cvOrigemDefault = (platform === 'ig' || platform === 'instagram') ? 'IG' : 'FB';

    // Aplica mapping local se existir (mídia, empreendimentos, etc.) — mesmo
    // sendo histórico, é útil pra cruzamento posterior com CV.
    const binding = { cv_origem: cvOrigemDefault };
    if (mapping?.mapping_active && mapping.midia_slug) {
        binding.bound_empreendimentos = mapping.bound_empreendimentos || null;
        binding.midia_slug = mapping.midia_slug;
        binding.tags = mapping.tags || null;
        if (mapping.cv_origem) binding.cv_origem = mapping.cv_origem;
    }

    const lead = await InboundLead.create({
        channel: 'meta_lead_ads',
        status: 'historical',                       // ← NÃO dispara CV
        nome:           data.nome || null,
        email:          normalizeEmail(data.email),
        telefone:       normalizePhone(data.telefone),
        documento:      data.documento || null,
        cep:            data.cep || null,
        endereco:       data.endereco || null,
        cidade:         data.cidade || null,
        estado:         data.estado || null,
        extra_fields:   data.extra_fields || null,

        meta_leadgen_id:  String(leadgenId),
        meta_form_id:     graphLead.form_id != null ? String(graphLead.form_id) : null,
        meta_campaign_id: graphLead.campaign_id != null ? String(graphLead.campaign_id) : null,
        meta_ad_id:       graphLead.ad_id != null ? String(graphLead.ad_id) : null,

        bound_empreendimentos: binding.bound_empreendimentos || null,
        midia_slug:            binding.midia_slug || null,
        cv_origem:             binding.cv_origem,
        tags:                  binding.tags || null,

        raw_payload: {
            import: 'historical',
            graph: graphLead,
        },
        // Sobrescreve created_at com a data real do lead na Meta (não o now()).
        createdAt: graphLead.created_time ? new Date(graphLead.created_time) : new Date(),
    }, {
        silent: false, // mantém timestamps custom
    });

    // Registra evento de import — não dispara nada.
    await recordLeadEvent({
        leadId: lead.id, type: 'historical_imported',
        statusFrom: null, statusTo: 'historical',
        message: 'Lead importado da Meta (histórico — não enviado ao CV).',
        detail: { leadgen_id: String(leadgenId), form_id: graphLead.form_id, campaign_id: graphLead.campaign_id },
    });

    return 'inserted';
}

/**
 * Importa leads de todos os forms cacheados. Janela: últimos `sinceDays` dias.
 * Retorna sumário por form.
 */
export async function importHistorical({ sinceDays = 90 } = {}) {
    const creds = await getCreds();
    const since = new Date();
    since.setDate(since.getDate() - sinceDays);

    // Pega os Page Access Tokens uma vez só (uma chamada).
    const pageTokens = await fetchPageTokens(creds);

    const forms = await MetaLeadForm.findAll({
        order: [['name', 'ASC']],
    });
    if (!forms.length) {
        return { forms_count: 0, inserted: 0, duplicates: 0, errors: [], details: [] };
    }

    let totalInserted = 0;
    let totalDuplicates = 0;
    const details = [];
    const errors = [];

    for (const form of forms) {
        const mapping = form.get({ plain: true });
        const formId = mapping.id;
        const pageToken = pageTokens.get(String(mapping.page_id));

        if (!pageToken) {
            errors.push({
                form_id: formId,
                form_name: mapping.name,
                error: `Página ${mapping.page_id} (${mapping.page_name || '?'}) sem Page Access Token — atribua ela ao System User Menin-Office.`,
            });
            continue;
        }

        let formLeads;
        try {
            formLeads = await fetchLeadsForForm(creds, formId, pageToken, { since });
        } catch (err) {
            const detail = err?.response?.data?.error?.message || err.message;
            errors.push({ form_id: formId, form_name: mapping.name, error: detail });
            continue;
        }

        let inserted = 0, duplicates = 0, formErr = 0;
        for (const lead of formLeads) {
            try {
                const result = await insertHistoricalLead({
                    leadgenId: lead.id,
                    graphLead: lead,
                    mapping,
                });
                if (result === 'inserted')  inserted += 1;
                if (result === 'duplicate') duplicates += 1;
            } catch (err) {
                formErr += 1;
                console.error(`❌ [historical-import] lead ${lead.id} (${formId}): ${err.message}`);
            }
        }

        totalInserted   += inserted;
        totalDuplicates += duplicates;
        details.push({
            form_id: formId,
            form_name: mapping.name,
            fetched: formLeads.length,
            inserted,
            duplicates,
            errors: formErr,
        });

        console.log(`📥 [historical-import] form ${formId} (${mapping.name}): ${inserted} novos, ${duplicates} duplicados, ${formErr} erros.`);
    }

    return {
        forms_count: forms.length,
        since: since.toISOString().slice(0, 10),
        inserted: totalInserted,
        duplicates: totalDuplicates,
        errors,
        details,
    };
}

/**
 * Re-processa leads Meta JÁ importados, aplicando a versão atual do parser.
 * Útil quando o parser foi melhorado e os leads antigos ficaram com campos
 * vazios (ex: nome=null porque o form usava 'Nome Completo' em vez de 'full_name').
 *
 * Lê raw_payload.graph.field_data, roda parseLeadFields, e atualiza APENAS
 * os campos que estão null no lead atual (não sobrescreve dados já presentes).
 *
 * Idempotente — pode rodar quantas vezes quiser.
 */
export async function reparseExistingLeads({ onlyMissingNome = true, limit = null } = {}) {
    const where = { channel: 'meta_lead_ads' };
    if (onlyMissingNome) where.nome = null;

    const queryOpts = {
        where,
        attributes: [
            'id', 'nome', 'email', 'telefone', 'documento', 'documento_tipo',
            'cidade', 'estado', 'cep', 'endereco', 'extra_fields', 'raw_payload',
        ],
        order: [['created_at', 'DESC']],
    };
    if (limit) queryOpts.limit = limit;

    const leads = await InboundLead.findAll(queryOpts);

    let updated = 0;
    let skippedNoPayload = 0;
    let skippedNoChange = 0;
    const errors = [];

    for (const lead of leads) {
        try {
            const fd = lead.raw_payload?.graph?.field_data;
            if (!Array.isArray(fd) || !fd.length) { skippedNoPayload += 1; continue; }

            const newData = parseLeadFields(fd);
            const patch = {};

            // Só preenche campos que estão null no lead atual.
            for (const k of ['nome', 'email', 'telefone', 'documento', 'cidade', 'estado', 'cep', 'endereco']) {
                if (!lead[k] && newData[k]) patch[k] = newData[k];
            }
            // Normaliza email/phone
            if (patch.email)    patch.email    = normalizeEmail(patch.email);
            if (patch.telefone) patch.telefone = normalizePhone(patch.telefone);

            // Mescla extra_fields (existentes ganham).
            if (newData.extra_fields) {
                const merged = { ...(newData.extra_fields), ...(lead.extra_fields || {}) };
                // Só atualiza se mudou
                if (JSON.stringify(merged) !== JSON.stringify(lead.extra_fields || {})) {
                    patch.extra_fields = merged;
                }
            }

            if (Object.keys(patch).length > 0) {
                await lead.update(patch);
                updated += 1;
            } else {
                skippedNoChange += 1;
            }
        } catch (e) {
            errors.push({ lead_id: lead.id, error: e.message });
        }
    }

    return {
        scanned: leads.length,
        updated,
        skipped_no_payload: skippedNoPayload,
        skipped_no_change: skippedNoChange,
        errors,
    };
}

export default { importHistorical, reparseExistingLeads };

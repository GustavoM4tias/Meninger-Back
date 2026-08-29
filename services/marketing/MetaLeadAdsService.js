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
import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { captureLead } from './LeadCaptureService.js';
import { recordLeadEvent } from './leadEventLog.js';
import MarketingConfigService from './MarketingConfigService.js';
import MetaLeadFormService from './MetaLeadFormService.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';

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

/**
 * Lista fechada dos campos do CV que aceitamos como destino de mapeamento.
 * Esses são os campos diretos do inbound_lead (que viram payload no CV CRM).
 * Tudo que não bate aqui vai pra 'extra' (JSONB extra_fields), ou 'ignore'.
 */
export const CV_TARGET_FIELDS = [
    { key: 'nome',           label: 'Nome',                       group: 'Identificação' },
    { key: 'email',          label: 'E-mail',                     group: 'Identificação' },
    { key: 'telefone',       label: 'Telefone / WhatsApp',        group: 'Identificação' },
    { key: 'documento',      label: 'Documento (CPF/CNPJ)',       group: 'Identificação' },
    { key: 'sexo',           label: 'Sexo',                       group: 'Demográfico' },
    { key: 'renda_familiar', label: 'Renda familiar',             group: 'Demográfico' },
    { key: 'cep',            label: 'CEP',                        group: 'Endereço' },
    { key: 'endereco',       label: 'Endereço (rua)',             group: 'Endereço' },
    { key: 'numero',         label: 'Número',                     group: 'Endereço' },
    { key: 'complemento',    label: 'Complemento',                group: 'Endereço' },
    { key: 'bairro',         label: 'Bairro',                     group: 'Endereço' },
    { key: 'cidade',         label: 'Cidade',                     group: 'Endereço' },
    { key: 'estado',         label: 'Estado / UF',                group: 'Endereço' },
    { key: 'extra',          label: 'extra_fields (custom JSON)', group: 'Custom' },
    { key: 'ignore',         label: 'Ignorar (não enviar)',       group: 'Custom' },
];
export const CV_TARGET_KEYS = new Set(CV_TARGET_FIELDS.map(f => f.key));

// Normaliza removendo espaços, traços, acentos e underscores → permite bater
// 'Nome Completo' com 'nome_completo' com 'nomecompleto'.
const norm = s => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // remove diacríticos
    .toLowerCase().replace(/[\s_\-]+/g, '').trim();

function pickField(fd, ...names) {
    const wanted = names.map(norm);
    for (const f of fd) {
        if (wanted.includes(norm(f?.name)) && Array.isArray(f?.values) && f.values.length) {
            const v = String(f.values[0]).trim();
            if (v) return v;
        }
    }
    return null;
}

// Variantes de cada campo CV — usadas pelo auto-detect.
const FIELD_VARIANTS = {
    email:    ['email', 'e_mail', 'emailaddress', 'seuemail', 'seuemailprincipal'],
    telefone: ['phone_number', 'phone', 'telefone', 'celular', 'whatsapp', 'fone',
               'telefonecontato', 'numerotelefone', 'numerowhatsapp',
               'qualseunumerodewhatsapp', 'qualseutelefone'],
    nome:     ['full_name', 'fullname', 'nome', 'nomecompleto', 'name',
               'seunome', 'qualseunome', 'qualseunomecompleto', 'comoseuchama', 'comosechama'],
    cidade:   ['city', 'cidade', 'suacidade'],
    estado:   ['state', 'province', 'estado', 'uf'],
    endereco: ['street_address', 'address', 'endereco'],
    cep:      ['post_code', 'zip_code', 'postal_code', 'cep'],
    documento: ['cpf', 'documento', 'cnpj'],
};

/**
 * Pra uma question key, retorna o campo CV que o auto-detect escolheria.
 * Retorna null se não bate em nenhuma variante (vai pra extra_fields).
 */
export function autoDetectCvField(questionKey) {
    const normKey = norm(questionKey);
    for (const [cvField, variants] of Object.entries(FIELD_VARIANTS)) {
        if (variants.map(norm).includes(normKey)) return cvField;
    }
    // first_name / last_name fallback: ambos viram parte de nome, mas como
    // único campo precisamos escolher um — devolvemos 'nome' (será concat
    // depois pelo parser quando ambos existirem).
    if (['firstname', 'lastname', 'primeironome', 'sobrenome', 'ultimonome'].includes(normKey)) {
        return 'nome';
    }
    return null;
}

/**
 * Mapeia o field_data do Meta para os campos do inbound_lead.
 *
 * Se `formMappings` for fornecido ({ "questionKey": "cvField" | "extra" | "ignore" }),
 * usa esse mapeamento FIRST, e completa o resto com auto-detecção.
 */
export function parseLeadFields(fieldData = [], { formMappings = null } = {}) {
    const fd = Array.isArray(fieldData) ? fieldData : [];
    const data = {};
    const extra = {};
    const consumedQuestions = new Set();

    // 1) Aplica formMappings explícitos primeiro.
    if (formMappings && typeof formMappings === 'object') {
        for (const f of fd) {
            if (!f?.name) continue;
            const target = formMappings[f.name];
            if (target == null) continue;
            consumedQuestions.add(f.name);

            const value = Array.isArray(f.values) && f.values.length ? String(f.values[0]).trim() : '';
            if (!value) continue;

            if (target === 'ignore') continue;
            if (target === 'extra') {
                const vals = Array.isArray(f.values) ? f.values : [];
                extra[f.name] = vals.length === 1 ? vals[0] : vals;
            } else if (CV_TARGET_KEYS.has(target)) {
                // Pra nome: se já tem (provavelmente first_name veio antes), concatena.
                if (target === 'nome' && data.nome) {
                    data.nome = (data.nome + ' ' + value).trim();
                } else {
                    data[target] = value;
                }
            }
        }
    }

    // 2) Auto-detect pros campos faltantes.
    const autoData = {
        email:    pickField(fd, ...FIELD_VARIANTS.email),
        telefone: pickField(fd, ...FIELD_VARIANTS.telefone),
        nome:     pickField(fd, ...FIELD_VARIANTS.nome),
        cidade:   pickField(fd, ...FIELD_VARIANTS.cidade),
        estado:   pickField(fd, ...FIELD_VARIANTS.estado),
        endereco: pickField(fd, ...FIELD_VARIANTS.endereco),
        cep:      pickField(fd, ...FIELD_VARIANTS.cep),
        documento: pickField(fd, ...FIELD_VARIANTS.documento),
    };
    if (!autoData.nome) {
        const first = pickField(fd, 'first_name', 'firstname', 'primeironome');
        const last  = pickField(fd, 'last_name',  'lastname',  'sobrenome', 'ultimonome');
        if (first || last) autoData.nome = [first, last].filter(Boolean).join(' ').trim();
    }
    for (const [k, v] of Object.entries(autoData)) {
        if (!data[k] && v) data[k] = v;
    }

    // 3) Tudo que não foi consumido por mapping/auto vai pra extra_fields,
    //    EXCETO o que o formMappings já mandou pra 'ignore'.
    for (const f of fd) {
        if (!f?.name) continue;
        if (consumedQuestions.has(f.name)) continue;
        const vals = Array.isArray(f.values) ? f.values : [];
        extra[f.name] = vals.length === 1 ? vals[0] : vals;
    }
    if (Object.keys(extra).length) data.extra_fields = extra;

    for (const k of Object.keys(data)) if (data[k] == null) delete data[k];
    return data;
}

// ── Resolução de vínculo CV ─────────────────────────────────────────────────

/**
 * Resolve o vínculo CV de um lead Meta: prioriza a CAMPANHA, com fallback ao
 * FORM (legado). É a MESMA lógica usada na captura ao vivo (processOneLead) e
 * no disparo de backlog histórico (CvBacklogDispatchService) — mantém o
 * roteamento idêntico nos dois caminhos.
 *
 * @returns {{ binding, attribution, cvExtraFields, resolvedCampaignId, mappingSource }}
 *   binding:     { cv_origem, bound_empreendimentos?, midia_slug?, tags? }
 *   attribution: { utm_source?, utm_medium?, utm_campaign?, utm_content?, utm_term? }
 *   cvExtraFields: objeto a mesclar SOB os dados do lead (lead vence), ou null
 *   resolvedCampaignId: campaignId final (já resolvido via ad→campanha se preciso)
 *   mappingSource: string descritiva ou null (null = sem vínculo → 'held')
 */
export async function resolveLeadBinding({ campaignId = null, adId = null, formId = null, platformOrigem = 'FB' } = {}) {
    const binding = { cv_origem: platformOrigem };
    const attribution = {};
    let cvExtraFields = null;
    let mappingSource = null;
    let resolvedCampaignId = campaignId != null ? String(campaignId) : null;

    // Fallback: a Meta nem sempre devolve campaign_id (lead orgânico, campanha
    // antiga, lead de teste). Se o ad_id veio, resolvemos via cache local de
    // MetaAd — que tem campaign_id como FK lógica das campanhas sincronizadas.
    if (!resolvedCampaignId && adId && db.MetaAd) {
        try {
            const ad = await db.MetaAd.findByPk(String(adId), { attributes: ['campaign_id'] });
            if (ad?.campaign_id) resolvedCampaignId = String(ad.campaign_id);
        } catch (e) {
            console.warn(`⚠️  [marketing-capture] falha ao resolver campaign_id pelo ad ${adId}: ${e.message}`);
        }
    }

    // 1) Tenta mapping da campanha
    if (resolvedCampaignId) {
        try {
            const camp = await db.MetaCampaign.findByPk(resolvedCampaignId);
            if (camp?.mapping_active && camp.midia_slug) {
                binding.bound_empreendimentos = camp.bound_empreendimentos || null;
                binding.midia_slug = camp.midia_slug;
                binding.tags = camp.tags || null;
                if (camp.cv_origem) binding.cv_origem = camp.cv_origem;
                mappingSource = `campanha ${resolvedCampaignId}`;
            }
            if (camp) {
                if (camp.default_utm_source)   attribution.utm_source   = camp.default_utm_source;
                if (camp.default_utm_medium)   attribution.utm_medium   = camp.default_utm_medium;
                if (camp.default_utm_campaign) attribution.utm_campaign = camp.default_utm_campaign;
                if (camp.default_utm_content)  attribution.utm_content  = camp.default_utm_content;
                if (camp.default_utm_term)     attribution.utm_term     = camp.default_utm_term;
                if (camp.cv_extra_fields && typeof camp.cv_extra_fields === 'object') {
                    cvExtraFields = { ...camp.cv_extra_fields };
                }
            }
        } catch (e) {
            console.warn(`⚠️  [marketing-capture] falha ao consultar mapping da campanha ${resolvedCampaignId}: ${e.message}`);
        }
    }

    // 2) Fallback: mapping do form (legado)
    //
    // Escopo configurável (Central Meta › Configurações). O form é um asset da
    // PÁGINA e atende campanhas de produtos diferentes — cobrir campanha sem
    // vínculo com o binding do form já mandou lead de Avaré pra Ibitinga
    // (incidente ago/2026). Em 'no_campaign' (default), lead COM campanha
    // identificada e sem vínculo represa (held) até alguém vincular a campanha;
    // o form só decide quando o lead não tem campanha nenhuma.
    let formFallbackAllowed = true;
    if (!binding.midia_slug && formId && resolvedCampaignId) {
        try {
            const cfg = await MarketingConfigService.getConfig();
            formFallbackAllowed = (cfg?.meta_form_fallback_scope || 'no_campaign') === 'always';
        } catch {
            formFallbackAllowed = false;   // na dúvida, held é melhor que destino errado
        }
    }
    if (!binding.midia_slug && formId && formFallbackAllowed) {
        try {
            const mapping = await MetaLeadFormService.findById(String(formId));
            if (mapping?.mapping_active && mapping.midia_slug) {
                binding.bound_empreendimentos = mapping.bound_empreendimentos || null;
                binding.midia_slug = mapping.midia_slug;
                binding.tags = mapping.tags || null;
                if (mapping.cv_origem) binding.cv_origem = mapping.cv_origem;
                mappingSource = `form ${formId} (fallback)`;
            }
            if (mapping) {
                if (!attribution.utm_source   && mapping.default_utm_source)   attribution.utm_source   = mapping.default_utm_source;
                if (!attribution.utm_medium   && mapping.default_utm_medium)   attribution.utm_medium   = mapping.default_utm_medium;
                if (!attribution.utm_campaign && mapping.default_utm_campaign) attribution.utm_campaign = mapping.default_utm_campaign;
                if (!attribution.utm_content  && mapping.default_utm_content)  attribution.utm_content  = mapping.default_utm_content;
                if (!attribution.utm_term     && mapping.default_utm_term)     attribution.utm_term     = mapping.default_utm_term;
                if (mapping.cv_extra_fields && typeof mapping.cv_extra_fields === 'object') {
                    cvExtraFields = { ...mapping.cv_extra_fields, ...(cvExtraFields || {}) };
                }
            }
        } catch (e) {
            // Não bloqueia a captura — só perde a otimização do mapping.
            console.warn(`⚠️  [marketing-capture] falha ao consultar mapping do form ${formId}: ${e.message}`);
        }
    }

    return { binding, attribution, cvExtraFields, resolvedCampaignId, mappingSource };
}

// ── Fetch resiliente ────────────────────────────────────────────────────────
// O Meta NÃO reenvia o webhook depois do nosso ACK 200 — se o fetch na Graph
// API falhar (token, timeout, rate limit), o lead evaporava sem registro nem
// alerta (a Meta contava, o Office nunca via). Agora a falha vira um STUB
// re-tentável em inbound_leads (status 'received' + error_code
// 'graph_fetch_failed') que o marketingDispatchScheduler re-busca com backoff.

const FETCH_MAX_ATTEMPTS = Number(process.env.MARKETING_FETCH_MAX_ATTEMPTS) || 6;

function fetchBackoffMs(attempts) {
    // 5, 10, 20, 40, 80 min... cap 2h.
    return Math.min(5 * 60_000 * 2 ** Math.max(0, attempts - 1), 2 * 60 * 60_000);
}

async function alertFetchDead(lead) {
    try {
        const userIds = await MarketingConfigService.getAlertRecipients();
        if (!userIds.length) return;
        await NotificationService.notify({
            type: NotificationType.LEAD_DISPATCH_FAILED,
            recipients: { users: userIds },
            title: 'Lead da Meta sem dados após várias tentativas',
            body: `O webhook recebeu o lead ${lead.meta_leadgen_id}, mas a busca dos dados na Graph API falhou ${FETCH_MAX_ATTEMPTS}x (${lead.last_error || 'erro desconhecido'}). Verifique o token da Meta em Configurações › Meta e use "Sincronizar Meta" na Captação pra importar o histórico.`,
            link: `/marketing/captacao?lead=${lead.id}`,
            importance: 8,
        });
    } catch (e) {
        console.error(`[marketing-capture] falha ao alertar fetch dead-letter: ${e.message}`);
    }
}

/** Registra (ou atualiza) o stub de um leadgen cujo fetch falhou. */
async function persistPendingFetch(value, err, pendingLead = null) {
    const leadgenId = String(value?.leadgen_id || '');
    try {
        if (!pendingLead) {
            pendingLead = await db.InboundLead.create({
                channel: 'meta_lead_ads',
                status: 'received',
                error_code: 'graph_fetch_failed',
                last_error: err.message,
                next_retry_at: new Date(Date.now() + fetchBackoffMs(1)),
                meta_leadgen_id: leadgenId || null,
                meta_form_id: value?.form_id != null ? String(value.form_id) : null,
                meta_page_id: value?.page_id != null ? String(value.page_id) : null,
                meta_ad_id:   value?.ad_id   != null ? String(value.ad_id)   : null,
                raw_payload: { webhook: value, fetch_attempts: 1 },
            });
            await recordLeadEvent({
                leadId: pendingLead.id, type: 'received', statusTo: 'received',
                message: `Webhook recebido, mas a busca dos dados na Graph API falhou: ${err.message}. Re-tentativa automática agendada.`,
            });
            console.warn(`⚠️  [marketing-capture] fetch do leadgen ${leadgenId} falhou (${err.message}) — stub re-tentável criado (${pendingLead.id}).`);
        } else {
            const attempts = (Number(pendingLead.raw_payload?.fetch_attempts) || 1) + 1;
            pendingLead.raw_payload = { ...(pendingLead.raw_payload || {}), fetch_attempts: attempts };
            pendingLead.last_error = err.message;
            if (attempts >= FETCH_MAX_ATTEMPTS) {
                pendingLead.next_retry_at = null;   // esgotou — requer ação manual
                await pendingLead.save();
                await recordLeadEvent({
                    leadId: pendingLead.id, type: 'dispatch_failed', actor: 'scheduler',
                    message: `Fetch na Graph API falhou ${attempts}x — sem novas tentativas automáticas. Último erro: ${err.message}`,
                });
                await alertFetchDead(pendingLead);
                console.error(`❌ [marketing-capture] leadgen ${leadgenId}: fetch esgotou ${attempts} tentativas.`);
            } else {
                pendingLead.next_retry_at = new Date(Date.now() + fetchBackoffMs(attempts));
                await pendingLead.save();
                console.warn(`⚠️  [marketing-capture] fetch do leadgen ${leadgenId} falhou de novo (${attempts}/${FETCH_MAX_ATTEMPTS}).`);
            }
        }
    } catch (e) {
        console.error(`❌ [marketing-capture] falha ao persistir pendência de fetch do leadgen ${leadgenId}: ${e.message}`);
    }
}

/**
 * Re-tenta o fetch dos stubs pendentes (chamado pelo marketingDispatchScheduler).
 * @returns {number} quantos stubs foram processados
 */
export async function retryPendingGraphFetches({ limit = 20 } = {}) {
    const due = await db.InboundLead.findAll({
        where: {
            status: 'received',
            error_code: 'graph_fetch_failed',
            next_retry_at: { [Op.lte]: new Date() },
        },
        order: [['next_retry_at', 'ASC']],
        limit,
    });
    for (const lead of due) {
        const value = lead.raw_payload?.webhook || {
            leadgen_id: lead.meta_leadgen_id,
            form_id: lead.meta_form_id,
            ad_id: lead.meta_ad_id,
            page_id: lead.meta_page_id,
        };
        try {
            await processOneLead(value, { pendingLead: lead });
        } catch (err) {
            console.error(`❌ [marketing-capture] retry de fetch do lead ${lead.id}: ${err.message}`);
        }
    }
    return due.length;
}

// ── Processamento do payload ────────────────────────────────────────────────

async function processOneLead(value, { pendingLead = null } = {}) {
    const leadgenId = value?.leadgen_id;
    if (!leadgenId) return;

    // Idempotência: o Meta pode reenviar o mesmo evento. (No retry de um stub,
    // o registro existente É o próprio stub — não é duplicata.)
    if (!pendingLead) {
        const already = await db.InboundLead.findOne({
            where: { meta_leadgen_id: String(leadgenId) },
            attributes: ['id'],
        });
        if (already) {
            console.log(`ℹ️  [marketing-capture] leadgen ${leadgenId} já capturado — ignorado.`);
            return;
        }
    }

    let graphLead;
    try {
        graphLead = await fetchLead(leadgenId);
    } catch (err) {
        await persistPendingFetch(value, err, pendingLead);
        return;
    }
    const platform = norm(graphLead.platform);
    const platformOrigem = (platform === 'ig' || platform === 'instagram') ? 'IG' : 'FB';

    const formId = value.form_id != null
        ? String(value.form_id)
        : (graphLead.form_id != null ? String(graphLead.form_id) : null);

    // Carrega field_mappings do form (se houver) ANTES de parsear, pra dar
    // ao parser a chance de respeitar a configuração manual do admin.
    let formMappings = null;
    if (formId) {
        try {
            const form = await db.MetaLeadForm.findByPk(formId, { attributes: ['field_mappings'] });
            if (form?.field_mappings && typeof form.field_mappings === 'object') {
                formMappings = form.field_mappings;
            }
        } catch (e) {
            console.warn(`⚠️  [marketing-capture] falha ao ler field_mappings do form ${formId}: ${e.message}`);
        }
    }
    const data = parseLeadFields(graphLead.field_data || [], { formMappings });

    // ── Mapping: prioriza CAMPANHA, fallback ao form (legado) ────────────────
    // Resolução centralizada em resolveLeadBinding (reusada no disparo de
    // backlog histórico, pra rotear igual ao ao vivo).
    const adId = value.ad_id != null
        ? String(value.ad_id)
        : (graphLead.ad_id != null ? String(graphLead.ad_id) : null);

    const { binding, attribution, cvExtraFields, resolvedCampaignId, mappingSource } =
        await resolveLeadBinding({ campaignId: graphLead.campaign_id, adId, formId, platformOrigem });
    const campaignId = resolvedCampaignId;
    if (cvExtraFields) {
        data.extra_fields = { ...cvExtraFields, ...(data.extra_fields || {}) };
    }

    if (mappingSource) {
        console.log(`🔗 [marketing-capture] mapping de ${mappingSource} → ${binding.midia_slug} (lead ${leadgenId}).`);
    } else {
        console.log(`⏸️  [marketing-capture] sem mapping pra lead ${leadgenId} (camp ${campaignId}, form ${formId}) — ficará em 'held'.`);
    }

    await captureLead({
        channel: 'meta_lead_ads',
        data,
        binding,
        attribution,
        meta: {
            leadgen_id:  String(leadgenId),
            form_id:     formId,
            page_id:     value.page_id != null ? String(value.page_id) : null,
            ad_id:       adId,
            campaign_id: campaignId,           // já pode ter sido resolvido via fallback ad→campanha
        },
        rawPayload: { webhook: value, graph: graphLead },
        existingLead: pendingLead,             // stub de fetch falho → completa em vez de criar
    });
    console.log(`✅ [marketing-capture] lead Meta ${leadgenId} capturado${pendingLead ? ' (recuperado após falha de fetch)' : ''}.`);
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

export default { verifySignature, verifyHandshake, fetchLead, parseLeadFields, processLeadgenPayload, retryPendingGraphFetches };

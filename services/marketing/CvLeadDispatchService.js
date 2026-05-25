// services/marketing/CvLeadDispatchService.js
//
// Despacha um inbound_lead para o CV CRM via POST /api/v1/comercial/leads.
//
// Contrato (ver doc CV — "Cadastra Leads"):
//  - identidade: email e/ou telefone (a deduplicação é feita pelo CV)
//  - origem (2 letras, imutável) = canal · midia (slug) = campanha/formulário
//  - idintegracao = nosso UUID (carimbo de origem / reconciliação)
//  - a resposta do POST traz `id` = idlead do CV → reconciliação imediata
//  - re-entrada (mesma pessoa de novo): permitir_alteracao + conversao
//  - idsituacao NÃO é enviado — o CV usa "Início" e aplica a fila depois
//
// Estados: routed/failed/rejected/dispatching → dispatching → resultado
//  - delivered: CV respondeu sucesso + id
//  - rejected:  CV recusou (HTTP 200 sucesso:false, ou HTTP 4xx) — ação manual
//  - failed:    erro transitório (rede/5xx) — re-tentado pelo scheduler com
//               backoff; esgotadas as tentativas → next_retry_at = null (dead-letter)

import { Op } from 'sequelize';
import apiCv from '../../lib/apiCv.js';
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';
import { recordLeadEvent } from './leadEventLog.js';
import MarketingConfigService from './MarketingConfigService.js';

const { InboundLead, User } = db;

const RETRY_BASE_MS = 2 * 60 * 1000;        // 2 min
const RETRY_CAP_MS  = 2 * 60 * 60 * 1000;   // 2 h
const DISPATCHABLE  = ['routed', 'failed', 'rejected', 'dispatching'];

// Acessos à config (DB com fallback pro .env) — cache de 30s dentro do service.
async function getCfg() {
    try { return await MarketingConfigService.getConfig(); }
    catch { return null; }
}
async function isDryRun() {
    const cfg = await getCfg();
    if (cfg) return !!cfg.dry_run;
    return process.env.MARKETING_CAPTURE_DRY_RUN === 'true';
}
async function getMaxAttempts() {
    const cfg = await getCfg();
    return cfg?.retry_max_attempts || Number(process.env.MARKETING_DISPATCH_MAX_ATTEMPTS) || 6;
}
async function getCvLeadsEndpoint() {
    const cfg = await getCfg();
    return cfg?.cv_leads_endpoint || process.env.CV_LEADS_ENDPOINT || '/v1/comercial/leads';
}

// Backoff exponencial: 2, 4, 8, 16... min (limitado a 2h).
function backoffMs(attempts) {
    return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_CAP_MS);
}

// ── Re-entrada ──────────────────────────────────────────────────────────────
// Mesma pessoa (email/telefone) que já foi entregue antes NÃO é duplicata —
// é uma nova conversão. Não confundir com spam.
async function detectReentry(lead) {
    const or = [];
    if (lead.email)    or.push({ email: lead.email });
    if (lead.telefone) or.push({ telefone: lead.telefone });
    if (!or.length) return false;
    const prior = await InboundLead.findOne({
        where: {
            id: { [Op.ne]: lead.id },
            status: 'delivered',
            [Op.or]: or,
        },
        attributes: ['id'],
    });
    return !!prior;
}

// ── Monta o JSON do CV ──────────────────────────────────────────────────────
function buildCvPayload(lead) {
    const p = {
        permitir_alteracao: true,   // cria-ou-atualiza: o CV deduplica por email/telefone
        idintegracao: lead.id,      // nosso UUID → reconciliação
    };

    if (lead.email) p.email = lead.email;
    if (lead.telefone) {
        p.telefone = lead.telefone;
        if (lead.telefone_ddi) p.telefone_ddi = lead.telefone_ddi;
    }
    if (lead.nome)       p.nome   = lead.nome;
    if (lead.midia_slug) p.midia  = lead.midia_slug;
    if (lead.cv_origem)  p.origem = lead.cv_origem;

    if (Array.isArray(lead.bound_empreendimentos) && lead.bound_empreendimentos.length) {
        p.idempreendimento = lead.bound_empreendimentos;
    }
    if (Array.isArray(lead.tags) && lead.tags.length) {
        p.tags = lead.tags;
    }
    if (lead.documento) {
        p.documento = lead.documento;
        if (lead.documento_tipo) p.documento_tipo = lead.documento_tipo;
    }
    if (lead.sexo)           p.sexo           = lead.sexo;
    if (lead.renda_familiar) p.renda_familiar = lead.renda_familiar;
    if (lead.cep)            p.cep            = lead.cep;
    if (lead.endereco)       p.endereco       = lead.endereco;
    if (lead.numero)         p.numero         = lead.numero;
    if (lead.complemento)    p.complemento    = lead.complemento;
    if (lead.bairro)         p.bairro         = lead.bairro;
    // estado/cidade exigem idestado/idcidade do CV — mapeamento de IDs em fase posterior.

    if (lead.channel === 'meta_lead_ads') {
        p.integracao = 'FB';
        if (lead.meta_form_id) p.idformulario = lead.meta_form_id;
    }

    if (lead.is_reentry && lead.conversao_name) {
        p.conversao = lead.conversao_name;
    }

    return p;
}

// ── Despacho ────────────────────────────────────────────────────────────────
/**
 * Envia um inbound_lead ao CV CRM. Idempotente quanto a status: só processa
 * leads despacháveis (routed/failed/rejected/dispatching).
 * @param {string|object} leadOrId  UUID ou a instância InboundLead
 */
export async function dispatchLead(leadOrId, { actor = 'system' } = {}) {
    const lead = typeof leadOrId === 'string'
        ? await InboundLead.findByPk(leadOrId)
        : leadOrId;

    if (!lead) throw new Error(`inbound_lead não encontrado: ${leadOrId}`);

    if (!DISPATCHABLE.includes(lead.status)) {
        return { skipped: true, reason: `status "${lead.status}" não é despachável` };
    }

    // Re-entrada: detecta antes de montar o payload.
    if (!lead.is_reentry && await detectReentry(lead)) {
        lead.is_reentry = true;
        lead.conversao_name = lead.midia_slug || lead.channel;
        await recordLeadEvent({
            leadId: lead.id, type: 'reentry_detected', actor,
            message: 'Lead já existe na base — tratado como nova conversão (não é spam).',
        });
    }

    const payload    = buildCvPayload(lead);
    const fromStatus = lead.status;

    lead.status             = 'dispatching';
    lead.dispatch_attempts  = (lead.dispatch_attempts || 0) + 1;
    lead.last_dispatch_at   = new Date();
    lead.cv_request_payload = payload;
    await lead.save();

    const dryRun = await isDryRun();
    await recordLeadEvent({
        leadId: lead.id, type: 'dispatch_attempt', actor,
        statusFrom: fromStatus, statusTo: 'dispatching',
        message: `Tentativa ${lead.dispatch_attempts} de envio ao CV.`,
        detail: { dry_run: dryRun },
    });

    // Modo sombra: pipeline completo, sem POST. O lead volta a 'routed'.
    if (dryRun) {
        lead.status = 'routed';
        lead.last_error = null;
        await lead.save();
        await recordLeadEvent({
            leadId: lead.id, type: 'dry_run', actor,
            statusFrom: 'dispatching', statusTo: 'routed',
            message: 'Modo sombra ativo — POST ao CV não realizado.',
            detail: { payload },
        });
        console.log(`🌓 [marketing-capture] dry-run — lead ${lead.id} não enviado ao CV.`);
        return { dryRun: true };
    }

    try {
        const endpoint = await getCvLeadsEndpoint();
        const res  = await apiCv.post(endpoint, payload);
        const body = res?.data || {};

        if (body.sucesso === true && body.id != null) {
            return await markDelivered(lead, body, actor);
        }
        // HTTP 200 mas sucesso:false → recusa lógica do CV.
        return await markRejected(lead, body, `CV recusou: ${body.mensagem || 'sem mensagem'}`, actor);
    } catch (err) {
        const resp = err?.response;
        if (resp && resp.status >= 400 && resp.status < 500) {
            // 4xx — requisição inválida; re-tentar não resolve.
            return await markRejected(lead, resp.data, `CV retornou HTTP ${resp.status}.`, actor);
        }
        // 5xx / rede / timeout — falha transitória.
        return await markFailed(lead, err, actor);
    }
}

async function markDelivered(lead, body, actor) {
    lead.status         = 'delivered';
    lead.cv_idlead      = String(body.id);
    lead.cv_situacao_id = body.idsituacao != null ? Number(body.idsituacao) : null;
    lead.cv_response    = body;
    lead.last_error     = null;
    lead.error_code     = null;
    lead.next_retry_at  = null;
    await lead.save();
    await recordLeadEvent({
        leadId: lead.id, type: 'cv_delivered', actor,
        statusFrom: 'dispatching', statusTo: 'delivered',
        message: `Lead criado no CV — idlead ${body.id}.`,
        detail: { codigo: body.codigo, mensagem: body.mensagem, idsituacao: body.idsituacao },
    });
    console.log(`✅ [marketing-capture] lead ${lead.id} entregue ao CV (idlead ${body.id}).`);
    return { delivered: true, cvIdlead: lead.cv_idlead };
}

async function markRejected(lead, cvBody, message, actor) {
    lead.status        = 'rejected';
    lead.cv_response   = cvBody || null;
    lead.last_error    = message;
    lead.error_code    = cvBody?.codigo != null ? `cv_${cvBody.codigo}` : 'cv_rejected';
    lead.next_retry_at = null;
    await lead.save();
    await recordLeadEvent({
        leadId: lead.id, type: 'cv_rejected', actor,
        statusFrom: 'dispatching', statusTo: 'rejected',
        message,
        detail: { cv_response: cvBody },
    });
    console.warn(`⛔ [marketing-capture] lead ${lead.id} recusado pelo CV: ${message}`);
    return { rejected: true };
}

async function markFailed(lead, err, actor) {
    const maxAttempts = await getMaxAttempts();
    const deadLetter = lead.dispatch_attempts >= maxAttempts;
    lead.status        = 'failed';
    lead.last_error    = (err?.message || 'erro desconhecido').slice(0, 1000);
    lead.error_code    = err?.response?.status ? `http_${err.response.status}` : (err?.code || 'network_error');
    lead.cv_response   = err?.response?.data || null;
    lead.next_retry_at = deadLetter ? null : new Date(Date.now() + backoffMs(lead.dispatch_attempts));
    await lead.save();

    if (deadLetter) {
        await recordLeadEvent({
            leadId: lead.id, type: 'dead_letter', actor,
            statusFrom: 'dispatching', statusTo: 'failed',
            message: `Falha definitiva após ${lead.dispatch_attempts} tentativas — requer ação manual.`,
            detail: { last_error: lead.last_error, error_code: lead.error_code },
        });
        console.error(`💀 [marketing-capture] lead ${lead.id} em dead-letter após ${lead.dispatch_attempts} tentativas.`);
        await alertDeadLetter(lead);
    } else {
        await recordLeadEvent({
            leadId: lead.id, type: 'dispatch_failed', actor,
            statusFrom: 'dispatching', statusTo: 'failed',
            message: `Falha transitória (tentativa ${lead.dispatch_attempts}) — re-tentativa agendada.`,
            detail: { last_error: lead.last_error, next_retry_at: lead.next_retry_at },
        });
        console.warn(`⚠️  [marketing-capture] lead ${lead.id} falhou (tentativa ${lead.dispatch_attempts}); retry em ${lead.next_retry_at?.toISOString()}.`);
    }
    return { failed: true, deadLetter };
}

// ── Alerta de dead-letter ───────────────────────────────────────────────────
// Avisa os admins quando um lead não consegue ser entregue ao CRM.
async function alertDeadLetter(lead) {
    try {
        const admins = await User.findAll({
            where: { role: 'admin', status: true },
            attributes: ['id'],
        });
        const userIds = admins.map(u => u.id);
        if (!userIds.length) return;

        await NotificationService.notify({
            type: NotificationType.LEAD_DISPATCH_FAILED,
            recipients: { users: userIds },
            title: 'Lead não entregue ao CRM',
            body: `O lead "${lead.nome || lead.email || lead.telefone || lead.id}" falhou ${lead.dispatch_attempts}x ao ser enviado ao CV e precisa de ação manual.`,
            data: { inbound_lead_id: lead.id, last_error: lead.last_error, error_code: lead.error_code },
            link: `/marketing/captacao?lead=${lead.id}`,
            importance: 8,
        });
    } catch (err) {
        console.error(`❌ [marketing-capture] falha ao alertar dead-letter do lead ${lead.id}: ${err.message}`);
    }
}

export default { dispatchLead };

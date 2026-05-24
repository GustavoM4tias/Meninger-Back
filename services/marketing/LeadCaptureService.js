// services/marketing/LeadCaptureService.js
//
// Pipeline de captação: cria o inbound_lead a partir de uma fonte (formulário,
// Meta...), registra a trilha de eventos, valida, resolve o vínculo e dispara
// o despacho ao CV.
//
//   received → validated → (routed | held) → [dispatch assíncrono]
//
// "held" = sem vínculo resolvido → aguarda roteamento manual (nunca vai ao CV
// no chute). Formulários sempre têm vínculo configurado, então caem em "routed".

import db from '../../models/sequelize/index.js';
import { recordLeadEvent } from './leadEventLog.js';
import { dispatchLead } from './CvLeadDispatchService.js';
import { validateLeadContact, normalizeEmail, normalizePhone } from './leadAntiSpam.js';

const { InboundLead } = db;

/**
 * Cria e processa um lead captado.
 * @returns {{ lead: object, status: string }}
 */
export async function captureLead({
    channel,
    data = {},          // nome, email, telefone, documento, extra_fields, ...
    binding = {},       // bound_empreendimentos, midia_slug, cv_origem, tags
    attribution = {},   // utm_*, referrer, landing_url, ip, user_agent
    consent = {},       // consent_at, consent_text_version, consent_ip
    meta = {},          // leadgen_id, form_id, page_id, campaign_id, ad_id
    rawPayload = null,
    sourceFormId = null,
    spam = false,       // honeypot já detectado pelo chamador
    spamReasons = null,
}) {
    const lead = await InboundLead.create({
        channel,
        status: 'received',
        nome:           data.nome || null,
        email:          normalizeEmail(data.email),
        telefone:       normalizePhone(data.telefone),
        telefone_ddi:   data.telefone_ddi || null,
        documento:      data.documento || null,
        documento_tipo: data.documento_tipo || null,
        sexo:           data.sexo || null,
        renda_familiar: data.renda_familiar || null,
        cep:            data.cep || null,
        endereco:       data.endereco || null,
        numero:         data.numero || null,
        complemento:    data.complemento || null,
        bairro:         data.bairro || null,
        cidade:         data.cidade || null,
        estado:         data.estado || null,
        extra_fields:   data.extra_fields || null,

        utm_source:   attribution.utm_source || null,
        utm_medium:   attribution.utm_medium || null,
        utm_campaign: attribution.utm_campaign || null,
        utm_content:  attribution.utm_content || null,
        utm_term:     attribution.utm_term || null,
        referrer:     attribution.referrer || null,
        landing_url:  attribution.landing_url || null,
        ip:           attribution.ip || null,
        user_agent:   attribution.user_agent || null,

        meta_leadgen_id:  meta.leadgen_id || null,
        meta_form_id:     meta.form_id || null,
        meta_page_id:     meta.page_id || null,
        meta_campaign_id: meta.campaign_id || null,
        meta_ad_id:       meta.ad_id || null,

        bound_empreendimentos: binding.bound_empreendimentos || null,
        midia_slug:            binding.midia_slug || null,
        cv_origem:             binding.cv_origem || null,
        tags:                  binding.tags || null,

        consent_at:           consent.consent_at || null,
        consent_text_version: consent.consent_text_version || null,
        consent_ip:           consent.consent_ip || null,

        raw_payload:    rawPayload,
        source_form_id: sourceFormId,
    });

    await recordLeadEvent({
        leadId: lead.id, type: 'received', statusTo: 'received',
        message: `Lead recebido via ${channel}.`,
    });

    // ── Anti-spam: honeypot detectado pelo chamador ─────────────────────────
    if (spam) {
        lead.status = 'spam';
        lead.is_spam = true;
        lead.spam_reasons = spamReasons || ['honeypot'];
        await lead.save();
        await recordLeadEvent({
            leadId: lead.id, type: 'spam_flagged',
            statusFrom: 'received', statusTo: 'spam',
            message: 'Marcado como spam.', detail: { reasons: lead.spam_reasons },
        });
        return { lead, status: 'spam' };
    }

    // ── Validação de contato (defesa em profundidade) ───────────────────────
    const contact = validateLeadContact({ email: lead.email, telefone: lead.telefone });
    if (!contact.ok) {
        lead.status = 'spam';
        lead.is_spam = true;
        lead.spam_reasons = contact.reasons;
        await lead.save();
        await recordLeadEvent({
            leadId: lead.id, type: 'spam_flagged',
            statusFrom: 'received', statusTo: 'spam',
            message: 'Reprovado na validação de contato.', detail: { reasons: contact.reasons },
        });
        return { lead, status: 'spam' };
    }

    lead.status = 'validated';
    await lead.save();
    await recordLeadEvent({
        leadId: lead.id, type: 'validated',
        statusFrom: 'received', statusTo: 'validated',
        message: 'Lead validado.',
    });

    // ── Roteamento ──────────────────────────────────────────────────────────
    const hasBinding = !!lead.midia_slug && !!lead.cv_origem;
    if (!hasBinding) {
        lead.status = 'held';
        await lead.save();
        await recordLeadEvent({
            leadId: lead.id, type: 'held',
            statusFrom: 'validated', statusTo: 'held',
            message: 'Sem vínculo resolvido (midia/origem) — aguardando roteamento manual.',
        });
        return { lead, status: 'held' };
    }

    lead.status = 'routed';
    await lead.save();
    await recordLeadEvent({
        leadId: lead.id, type: 'routed',
        statusFrom: 'validated', statusTo: 'routed',
        message: 'Lead roteado — pronto para despacho ao CV.',
        detail: {
            midia: lead.midia_slug,
            origem: lead.cv_origem,
            empreendimentos: lead.bound_empreendimentos,
        },
    });

    // ── Despacho assíncrono — não bloqueia a resposta ao cliente.
    // Se falhar, o lead fica em 'failed' e o scheduler re-tenta.
    dispatchLead(lead).catch(err => {
        console.error(`❌ [marketing-capture] erro no despacho do lead ${lead.id}: ${err.message}`);
    });

    return { lead, status: 'routed' };
}

export default { captureLead };

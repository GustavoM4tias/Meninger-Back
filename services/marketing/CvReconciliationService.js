// services/marketing/CvReconciliationService.js
//
// Busca no CV CRM o lead correspondente a um inbound_lead (por email ou
// telefone) e atualiza o `cv_idlead` no nosso registro. Usado pra "casar"
// leads históricos importados da Meta com o que já existe no CV via RD.
//
// Não envia nada ao CV — só LÊ. Operação totalmente segura no modo dry-run.

import apiCv from '../../lib/apiCv.js';
import db from '../../models/sequelize/index.js';

const { InboundLead } = db;

/**
 * Tenta achar um lead no CV pelo email. Retorna o array de candidatos.
 * O endpoint CV aceita filtros via query params. Em caso de erro, retorna [].
 */
async function searchByEmail(email) {
    if (!email) return [];
    try {
        const r = await apiCv.get('/v1/comercial/leads', { params: { email } });
        const list = r.data?.dados || r.data?.data || r.data?.results || r.data || [];
        return Array.isArray(list) ? list : [];
    } catch (err) {
        console.warn(`[cv-reconcile] busca por email '${email}' falhou: ${err.message}`);
        return [];
    }
}

async function searchByPhone(telefone) {
    if (!telefone) return [];
    // Remove tudo que não é dígito pra busca (CV costuma normalizar).
    const digits = String(telefone).replace(/\D/g, '');
    if (digits.length < 8) return [];
    try {
        const r = await apiCv.get('/v1/comercial/leads', { params: { telefone: digits } });
        const list = r.data?.dados || r.data?.data || r.data?.results || r.data || [];
        return Array.isArray(list) ? list : [];
    } catch (err) {
        console.warn(`[cv-reconcile] busca por telefone '${digits}' falhou: ${err.message}`);
        return [];
    }
}

/**
 * Heurística pra escolher o melhor match:
 *  1. Email exato bate → primeiro candidato com email igual
 *  2. Telefone exato bate → primeiro candidato com telefone com mesmos dígitos
 *  3. Senão: primeiro candidato (se houver) com baixa confiança
 */
function pickBestMatch(lead, candidates) {
    if (!candidates.length) return null;

    const leadEmail = String(lead.email || '').toLowerCase().trim();
    const leadDigits = String(lead.telefone || '').replace(/\D/g, '');

    // Match exato por email
    if (leadEmail) {
        const exact = candidates.find(c => {
            const e = String(c.email || c.Email || '').toLowerCase().trim();
            return e && e === leadEmail;
        });
        if (exact) return { match: exact, confidence: 'high', via: 'email' };
    }

    // Match exato por telefone (mesmo digitos)
    if (leadDigits.length >= 8) {
        const exact = candidates.find(c => {
            const t = String(c.telefone || c.celular || c.Phone || c.fone || '').replace(/\D/g, '');
            return t && (t.endsWith(leadDigits) || leadDigits.endsWith(t));
        });
        if (exact) return { match: exact, confidence: 'high', via: 'telefone' };
    }

    // Fallback: primeiro candidato (baixa confiança)
    return { match: candidates[0], confidence: 'low', via: 'fallback' };
}

/**
 * Reconcilia um lead com o CV.
 * Retorna { matched: bool, cv_idlead?: string, candidates_count: int, via: 'email'|'telefone'|null }.
 */
export async function reconcileLead(leadId) {
    const lead = await InboundLead.findByPk(leadId);
    if (!lead) throw new Error('Lead não encontrado.');

    // Se já tem cv_idlead, não pesquisa de novo.
    if (lead.cv_idlead) {
        return {
            matched: true, cv_idlead: lead.cv_idlead, candidates_count: 0,
            via: 'already_reconciled', already: true,
        };
    }

    const byEmail = await searchByEmail(lead.email);
    const byPhone = await searchByPhone(lead.telefone);

    // Combina + dedupe por idlead
    const candidatesMap = new Map();
    for (const c of [...byEmail, ...byPhone]) {
        const id = c.idlead || c.idLead || c.id || c.codigo;
        if (id && !candidatesMap.has(String(id))) candidatesMap.set(String(id), c);
    }
    const candidates = [...candidatesMap.values()];

    if (!candidates.length) {
        return { matched: false, candidates_count: 0, via: null };
    }

    const result = pickBestMatch(lead, candidates);
    if (!result?.match) {
        return { matched: false, candidates_count: candidates.length, via: null };
    }

    const cvIdlead = result.match.idlead || result.match.idLead || result.match.id || result.match.codigo;
    if (!cvIdlead) {
        return { matched: false, candidates_count: candidates.length, via: result.via };
    }

    // Salva no nosso lead
    lead.cv_idlead = String(cvIdlead);
    if (result.match.situacao?.id || result.match.idsituacao) {
        lead.cv_situacao_id = Number(result.match.situacao?.id || result.match.idsituacao) || null;
    }
    // Preserva snapshot mínimo do match (não a resposta inteira pra não bloar).
    lead.cv_response = {
        reconciled_at: new Date().toISOString(),
        via: result.via,
        confidence: result.confidence,
        candidate: {
            idlead: cvIdlead,
            nome: result.match.nome || result.match.Nome,
            email: result.match.email || result.match.Email,
            telefone: result.match.telefone || result.match.celular || result.match.Phone,
        },
    };
    await lead.save();

    return {
        matched: true,
        cv_idlead: String(cvIdlead),
        candidates_count: candidates.length,
        via: result.via,
        confidence: result.confidence,
    };
}

/**
 * Reconcilia em lote leads que ainda não têm cv_idlead. Padrão: leads Meta
 * históricos (channel='meta_lead_ads' AND status='historical') sem cv_idlead.
 */
export async function reconcileBatch({ limit = 100, channel = 'meta_lead_ads', status = 'historical' } = {}) {
    const where = { cv_idlead: null };
    if (channel) where.channel = channel;
    if (status)  where.status = status;

    const leads = await InboundLead.findAll({
        where,
        attributes: ['id'],
        order: [['created_at', 'DESC']],
        limit,
    });

    let matched = 0, unmatched = 0, errors = 0;
    for (const lead of leads) {
        try {
            const r = await reconcileLead(lead.id);
            if (r.matched) matched += 1; else unmatched += 1;
        } catch {
            errors += 1;
        }
    }
    return { processed: leads.length, matched, unmatched, errors };
}

export default { reconcileLead, reconcileBatch };

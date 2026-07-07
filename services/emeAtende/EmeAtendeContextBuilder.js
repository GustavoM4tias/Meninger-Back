// services/emeAtende/EmeAtendeContextBuilder.js
//
// Monta o contexto de negócio AO VIVO a partir do empreendimento do CV
// (cv_enterprises) + Ficha Comercial (enterprise_conditions) mais recente
// aprovada. Chamado a cada rodada de IA e no preview da tela - a ficha do mês
// muda, a Eme muda junto, sem editar fluxo.
//
// REGRA DURA: comissão, CCA, custos internos e imobiliárias NUNCA entram
// (informação interna - o lead não pode receber).

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

const DEFAULT_SOURCES = { basic: true, delivery: true, negotiation: true, subsidy: true, benefits: true, campaigns: true };

function money(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}

function line(label, value) {
    if (value === null || value === undefined || value === '') return null;
    return `- ${label}: ${value}`;
}

function section(title, lines) {
    const rows = lines.filter(Boolean);
    if (!rows.length) return null;
    return `${title}\n${rows.join('\n')}`;
}

function buildBasic(ent) {
    const local = [ent.bairro, ent.cidade, ent.estado].filter(Boolean).join(', ');
    return section(`EMPREENDIMENTO: ${ent.nome}`, [
        line('Localização', local || null),
        line('Endereço', ent.endereco_emp || ent.logradouro || null),
        line('Tipo/segmento', [ent.tipo_empreendimento_nome, ent.segmento_nome].filter(Boolean).join(' / ') || null),
        line('Situação da obra', ent.situacao_obra_nome),
        line('Andamento da obra', ent.andamento != null ? `${Number(ent.andamento).toFixed(0)}%` : null),
        line('Previsão de entrega', ent.data_entrega),
        line('Unidades disponíveis', ent.unidades_disponiveis != null ? String(ent.unidades_disponiveis) : null),
        ent.descricao ? `- Sobre: ${String(ent.descricao).replace(/\s+/g, ' ').trim().slice(0, 600)}` : null,
    ]);
}

function buildDelivery(ficha) {
    return section('PRAZO DE ENTREGA (ficha comercial)', [
        line('Prazo', ficha.delivery_deadline_months ? `${ficha.delivery_deadline_months} meses` : null),
        line('Observação', ficha.delivery_deadline_note),
    ]);
}

function buildNegotiation(ficha) {
    return section('CONDIÇÕES DE NEGOCIAÇÃO (ficha comercial vigente)', [
        line('Entrada máxima', money(ficha.max_entry_value)),
        line('Valor do ato', money(ficha.act_installment_value)),
        line('Parcela mínima', money(ficha.min_installment_value)),
        line('Parcela RP', money(ficha.rp_installment_value)),
        line('Máx. de parcelas', ficha.max_installments ? String(ficha.max_installments) : null),
        line('Correção até habite-se', ficha.installment_until_habite_se),
        line('Correção pós habite-se', ficha.installment_post_habite_se),
        line('Regra RP', ficha.rp_rule),
        line('Premissa de preço', ficha.price_premise_note),
    ]);
}

function buildSubsidy(ficha) {
    if (!ficha.has_state_subsidy) return null;
    return section('SUBSÍDIO ESTADUAL', [
        line('Programa', ficha.state_subsidy_program || ficha.state_subsidy_note),
        line('Estado', ficha.state_subsidy_custom_state || (ficha.state_subsidy_state ? String(ficha.state_subsidy_state).toUpperCase() : null)),
        line('Regras', ficha.state_subsidy_rules),
        line('Condições', ficha.state_subsidy_conditions),
    ]);
}

function buildBenefits(ficha) {
    const lines = [];
    if (ficha.pays_cef_package) lines.push(line('Pacote CEF pago pela construtora', [money(ficha.cef_package_value), ficha.cef_package_note].filter(Boolean).join(' - ') || 'sim'));
    if (ficha.pays_cartorio) lines.push(line('Cartório pago pela construtora', money(ficha.cartorio_value) || 'sim'));
    if (ficha.itbi_exempt) lines.push(line('ITBI', 'isento'));
    else if (ficha.pays_itbi) lines.push(line('ITBI pago pela construtora', [money(ficha.itbi_value), ficha.itbi_note].filter(Boolean).join(' - ') || 'sim'));
    return section('BENEFÍCIOS AO CLIENTE', lines);
}

function buildCampaigns(campaigns) {
    const today = new Date().toISOString().slice(0, 10);
    const active = (campaigns || []).filter(c =>
        c.is_active
        && (!c.start_date || c.start_date <= today)
        && (!c.end_date || c.end_date >= today)
    );
    if (!active.length) return null;
    return section('CAMPANHAS/PROMOÇÕES VIGENTES', active.map(c => {
        const until = c.end_date ? ` (válida até ${c.end_date.split('-').reverse().join('/')})` : '';
        const desc = c.description ? ` - ${String(c.description).replace(/\s+/g, ' ').trim().slice(0, 300)}` : '';
        return `- ${c.title}${until}${desc}`;
    }));
}

/**
 * Monta o contexto automático de um fluxo.
 * @returns {Promise<{text: string, meta: object}>} text = '' quando sem vínculo
 */
async function buildContext(flow) {
    const entId = flow?.cv_enterprise_id;
    if (!entId) return { text: '', meta: { linked: false } };

    const sources = { ...DEFAULT_SOURCES, ...(flow.context_sources || {}) };
    const meta = { linked: true, enterprise: null, ficha_month: null, ficha_status: null };
    const parts = [];

    try {
        const ent = await db.CvEnterprise.findByPk(entId);
        if (ent) {
            meta.enterprise = ent.nome;
            if (sources.basic) parts.push(buildBasic(ent));
        }

        const wantsFicha = sources.delivery || sources.negotiation || sources.subsidy || sources.benefits || sources.campaigns;
        if (wantsFicha) {
            const ficha = await db.EnterpriseCondition.findOne({
                where: { idempreendimento: entId, status: { [Op.in]: ['approved', 'closed'] } },
                order: [['reference_month', 'DESC']],
                include: [{ model: db.EnterpriseConditionCampaign, as: 'campaigns' }],
            });
            if (ficha) {
                meta.ficha_month = ficha.reference_month;
                meta.ficha_status = ficha.status;
                const monthLabel = String(ficha.reference_month || '').slice(0, 7).split('-').reverse().join('/');
                parts.push(`(Ficha comercial de referência: ${monthLabel})`);
                if (sources.delivery) parts.push(buildDelivery(ficha));
                if (sources.negotiation) parts.push(buildNegotiation(ficha));
                if (sources.subsidy) parts.push(buildSubsidy(ficha));
                if (sources.benefits) parts.push(buildBenefits(ficha));
                if (sources.campaigns) parts.push(buildCampaigns(ficha.campaigns));
            } else {
                parts.push('(Sem ficha comercial aprovada para este empreendimento - não afirme condições de pagamento; transfira para humano se o lead pedir.)');
            }
        }
    } catch (err) {
        console.error('[eme-atende/context] falha montando contexto:', err?.message);
        return { text: '', meta: { linked: true, error: err?.message } };
    }

    return { text: parts.filter(Boolean).join('\n\n'), meta };
}

/**
 * Contexto COMPLETO do fluxo: automático (CV/ficha) + manual (business_context).
 */
async function fullContext(flow) {
    const auto = await buildContext(flow);
    const manual = String(flow?.business_context || '').trim();
    const text = [auto.text, manual].filter(Boolean).join('\n\n');
    return { text, meta: auto.meta };
}

export default { buildContext, fullContext };

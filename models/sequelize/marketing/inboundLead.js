// models/sequelize/marketing/inboundLead.js
//
// Lead captado pela camada de marketing do Office (Meta Lead Ads, formulário do
// site, etc.) — do recebimento até o despacho para o CV CRM.
//
// É uma tabela SEPARADA do model `leads` (cv/lead.js, espelho read-only do CV):
// o inbound_lead tem ciclo de vida próprio e só ganha `cv_idlead` quando o CV
// confirma a criação. Sem ENUM — campos de estado são STRING (ver feedback de
// schema via sequelize.sync alter).

export default (sequelize, DataTypes) => {
  const InboundLead = sequelize.define('InboundLead', {
    // UUID — também é enviado ao CV como `idintegracao` (carimbo de origem).
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    // 'meta_lead_ads' | 'site_form'  (futuro: 'landing_page' | 'google_ads')
    channel: { type: DataTypes.STRING(30), allowNull: false },

    // Máquina de estados:
    //   received | validated | spam | held | routed | dispatching
    //           | delivered | rejected | failed
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'received' },

    // ── Dados do lead ────────────────────────────────────────────────────────
    nome:           { type: DataTypes.STRING(255) },
    email:          { type: DataTypes.STRING(255) },
    telefone:       { type: DataTypes.STRING(30) },
    telefone_ddi:   { type: DataTypes.STRING(8) },
    documento:      { type: DataTypes.STRING(30) },
    documento_tipo: { type: DataTypes.STRING(10) },   // 'cpf' | 'cnpj'
    sexo:           { type: DataTypes.STRING(1) },     // 'M' | 'F'
    renda_familiar: { type: DataTypes.STRING(40) },
    cep:            { type: DataTypes.STRING(12) },
    endereco:       { type: DataTypes.STRING(255) },
    numero:         { type: DataTypes.STRING(20) },
    complemento:    { type: DataTypes.STRING(120) },
    bairro:         { type: DataTypes.STRING(120) },
    cidade:         { type: DataTypes.STRING(120) },
    estado:         { type: DataTypes.STRING(60) },
    // Campos coletados pelo formulário que não têm coluna dedicada.
    extra_fields:   { type: DataTypes.JSONB },

    // ── Atribuição ───────────────────────────────────────────────────────────
    utm_source:   { type: DataTypes.STRING(255) },
    utm_medium:   { type: DataTypes.STRING(255) },
    utm_campaign: { type: DataTypes.STRING(255) },
    utm_content:  { type: DataTypes.STRING(255) },
    utm_term:     { type: DataTypes.STRING(255) },
    referrer:     { type: DataTypes.STRING(500) },
    landing_url:  { type: DataTypes.STRING(500) },
    ip:           { type: DataTypes.STRING(60) },
    user_agent:   { type: DataTypes.STRING(400) },

    // ── Origem Meta ──────────────────────────────────────────────────────────
    meta_leadgen_id:  { type: DataTypes.STRING(60) },
    meta_form_id:     { type: DataTypes.STRING(60) },
    meta_page_id:     { type: DataTypes.STRING(60) },
    meta_campaign_id: { type: DataTypes.STRING(60) },
    meta_ad_id:       { type: DataTypes.STRING(60) },

    // ── Vínculo resolvido (roteamento → CV) ──────────────────────────────────
    bound_empreendimentos: { type: DataTypes.JSONB },     // [int] idempreendimento CV
    midia_slug:            { type: DataTypes.STRING(60) },
    cv_origem:             { type: DataTypes.STRING(4) },  // código de 2 letras do enum CV
    tags:                  { type: DataTypes.JSONB },      // [string]

    // ── Re-entrada (mesma pessoa de novo → conversão, não duplicata) ─────────
    is_reentry:     { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    conversao_name: { type: DataTypes.STRING(120) },

    // ── Resultado no CV CRM ──────────────────────────────────────────────────
    cv_idlead:          { type: DataTypes.STRING(30) },   // resposta do POST = reconciliação
    cv_situacao_id:     { type: DataTypes.INTEGER },
    cv_request_payload: { type: DataTypes.JSONB },         // o que foi enviado ao CV
    cv_response:        { type: DataTypes.JSONB },         // resposta completa do CV

    // ── Controle de entrega ──────────────────────────────────────────────────
    dispatch_attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    last_dispatch_at:  { type: DataTypes.DATE },
    next_retry_at:     { type: DataTypes.DATE },   // null = sem retry (entregue ou dead-letter)
    last_error:        { type: DataTypes.TEXT },
    error_code:        { type: DataTypes.STRING(60) },

    // ── Qualidade / LGPD ─────────────────────────────────────────────────────
    is_spam:              { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    spam_reasons:         { type: DataTypes.JSONB },
    consent_at:           { type: DataTypes.DATE },
    consent_text_version: { type: DataTypes.STRING(60) },
    consent_ip:           { type: DataTypes.STRING(60) },

    // ── Auditoria ────────────────────────────────────────────────────────────
    raw_payload:    { type: DataTypes.JSONB },     // payload original intocado
    source_form_id: { type: DataTypes.INTEGER },   // FK lógica → lead_forms (Fase 1, passo 4)
  }, {
    tableName: 'inbound_leads',
    underscored: true,
    timestamps: true,   // created_at = momento da captação
  });

  return InboundLead;
};

// models/sequelize/marketing/leadForm.js
//
// Formulário de captação de leads embarcável no site. Cada form tem um vínculo
// fixo (empreendimento(s), midia, origem, tags) aplicado a todo lead que chega
// por ele. O slug identifica o form na URL pública de submit.

export default (sequelize, DataTypes) => {
  const LeadForm = sequelize.define('LeadForm', {
    id:     { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    slug:   { type: DataTypes.STRING(60), allowNull: false, unique: true },
    name:   { type: DataTypes.STRING(120), allowNull: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

    // Definição dos campos esperados — [{ key, label, required }]. Usado em
    // validações futuras. Se vazio, vale o conjunto padrão do controller.
    fields: { type: DataTypes.JSONB },

    // Quais campos o formulário pede e quais são obrigatórios.
    // Array de { key, label, required, enabled }. Default: nome + email + telefone.
    fields_config: { type: DataTypes.JSONB },

    // Configuração visual da landing page hospedada em lp.menin.com.br/<slug>:
    // { title, subtitle, background_color, background_image_url, accent_color,
    //   logo_url, cta_button_text, success_message }
    page_config: { type: DataTypes.JSONB },

    // ── Vínculo (roteamento → CV) ────────────────────────────────────────────
    bound_empreendimentos: { type: DataTypes.JSONB },          // [int] idempreendimento CV
    midia_slug:            { type: DataTypes.STRING(60) },
    cv_origem:             { type: DataTypes.STRING(4), allowNull: false, defaultValue: 'SI' }, // WebSite
    tags:                  { type: DataTypes.JSONB },          // [string]

    // ── LGPD ─────────────────────────────────────────────────────────────────
    consent_required:     { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    consent_text:         { type: DataTypes.TEXT },
    consent_text_version: { type: DataTypes.STRING(60) },

    // Domínios autorizados (registro/diagnóstico). O CORS do endpoint público
    // é permissivo — a proteção real é o anti-spam, não o CORS.
    allowed_origins: { type: DataTypes.JSONB },                 // [string]

    // Redirecionamento pós-cadastro (página de obrigado).
    redirect_url: { type: DataTypes.STRING(500) },

    // ── Metadados internos (gestão pela equipe) ─────────────────────────────
    description:  { type: DataTypes.TEXT },                            // nota interna sobre o form
    priority:     { type: DataTypes.STRING(10), defaultValue: 'normal' }, // low | normal | high
    campaign_ref: { type: DataTypes.STRING(120) },                     // referência curta da campanha

    // ── Programação (campanha) ──────────────────────────────────────────────
    // start_date informativo — usado pra filtros/relatórios.
    // end_date opcional — quando passar dessa data o form passa a recusar
    // submissões mesmo com active=true (controle via controller).
    start_date: { type: DataTypes.DATEONLY },
    end_date:   { type: DataTypes.DATEONLY },

    // ── UTMs default — aplicados ao lead quando o payload não traz ──────────
    default_utm_source:   { type: DataTypes.STRING(120) },
    default_utm_medium:   { type: DataTypes.STRING(120) },
    default_utm_campaign: { type: DataTypes.STRING(120) },
    default_utm_content:  { type: DataTypes.STRING(120) },
    default_utm_term:     { type: DataTypes.STRING(120) },

    // Campos extras a enviar ao CV (key:value).
    cv_extra_fields: { type: DataTypes.JSONB },
  }, {
    tableName: 'lead_forms',
    underscored: true,
    timestamps: true,
  });

  return LeadForm;
};

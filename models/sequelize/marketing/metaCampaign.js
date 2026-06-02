// models/sequelize/marketing/metaCampaign.js
//
// Cache local das campanhas Meta + insights (gasto, impressões, etc).
// PK = meta_campaign_id (string). Atualizado on-demand via
// MetaCampaignService.syncFromMeta(), que itera contas de anúncio acessíveis
// pelo System User e busca campanhas + spend de uma janela configurável.

export default (sequelize, DataTypes) => {
  const MetaCampaign = sequelize.define('MetaCampaign', {
    // ── Identificação (vem da Meta) ──────────────────────────────────────────
    id:              { type: DataTypes.STRING(40), primaryKey: true },  // meta_campaign_id
    account_id:      { type: DataTypes.STRING(40), allowNull: false },  // act_xxx
    account_name:    { type: DataTypes.STRING(255) },
    name:            { type: DataTypes.STRING(255) },
    status:          { type: DataTypes.STRING(40) },  // ACTIVE | PAUSED | DELETED | ARCHIVED
    effective_status: { type: DataTypes.STRING(60) }, // mais granular (ex: CAMPAIGN_PAUSED, ADSETS_PAUSED)
    objective:       { type: DataTypes.STRING(60) },  // LEAD_GENERATION | OUTCOME_LEADS | etc
    buying_type:     { type: DataTypes.STRING(40) },  // AUCTION | RESERVED

    start_time:      { type: DataTypes.DATE },
    stop_time:       { type: DataTypes.DATE },        // null se não tiver fim definido
    updated_time:    { type: DataTypes.DATE },        // última modificação na Meta (pause/resume/edit)

    // Orçamento — vem em centavos na Marketing API. Mantemos como string pra
    // não perder precisão (BIGINT em alguns casos).
    daily_budget_cents:    { type: DataTypes.BIGINT },
    lifetime_budget_cents: { type: DataTypes.BIGINT },
    budget_remaining_cents: { type: DataTypes.BIGINT },
    currency:        { type: DataTypes.STRING(10), defaultValue: 'BRL' },

    // ── Insights (denormalized cache) ────────────────────────────────────────
    spend:           { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },   // gasto total no período sincronizado
    impressions:     { type: DataTypes.INTEGER, defaultValue: 0 },
    clicks:          { type: DataTypes.INTEGER, defaultValue: 0 },
    reach:           { type: DataTypes.INTEGER, defaultValue: 0 },
    cpm:             { type: DataTypes.DECIMAL(10, 2) },                    // custo por mil impressões
    cpc:             { type: DataTypes.DECIMAL(10, 2) },                    // custo por clique
    ctr:             { type: DataTypes.DECIMAL(7, 4) },                     // click-through-rate (%)

    // Leads contabilizados pela própria Meta (actions.lead / leadgen.other).
    // Útil pra ver histórico de campanhas antigas que não passaram pelo nosso
    // webhook. Separado de lead_stats.total (que vem do nosso inbound_leads).
    meta_leads_total: { type: DataTypes.INTEGER, defaultValue: 0 },

    // ── Sync metadata ────────────────────────────────────────────────────────
    last_synced_at:   { type: DataTypes.DATE },
    last_insights_at: { type: DataTypes.DATE },
    insights_since:   { type: DataTypes.DATEONLY },                         // janela do último insights
    insights_until:   { type: DataTypes.DATEONLY },

    // ── Gestão interna ───────────────────────────────────────────────────────
    notes:    { type: DataTypes.TEXT },
    priority: { type: DataTypes.STRING(10), defaultValue: 'normal' },
    archived: { type: DataTypes.BOOLEAN, defaultValue: false },             // ocultar da listagem padrão

    // ── Vínculo CV (mapeamento de roteamento) ──────────────────────────────
    // Movido do MetaLeadForm pra cá: faz mais sentido amarrar campanha →
    // empreendimento. Forms agora são só "estrutura" (perguntas que o form
    // captura). Mesma campanha pode rodar com vários forms.
    bound_empreendimentos: { type: DataTypes.JSONB },                       // [int] idempreendimento CV
    midia_slug:            { type: DataTypes.STRING(60) },
    cv_origem:             { type: DataTypes.STRING(4) },                   // FB | IG (override de platform)
    tags:                  { type: DataTypes.JSONB },                       // [string]
    mapping_active:        { type: DataTypes.BOOLEAN, defaultValue: true }, // false = lead vira held

    // UTMs default aplicados ao lead quando o payload não traz.
    default_utm_source:   { type: DataTypes.STRING(120) },
    default_utm_medium:   { type: DataTypes.STRING(120) },
    default_utm_campaign: { type: DataTypes.STRING(120) },
    default_utm_content:  { type: DataTypes.STRING(120) },
    default_utm_term:     { type: DataTypes.STRING(120) },

    // Campos extras pro CV (key-value, mesclados em extra_fields do lead).
    cv_extra_fields: { type: DataTypes.JSONB },
  }, {
    tableName: 'meta_campaigns',
    underscored: true,
    timestamps: true,
    indexes: [
      { fields: ['account_id'] },
      { fields: ['status'] },
      { fields: ['start_time'] },
    ],
  });

  return MetaCampaign;
};

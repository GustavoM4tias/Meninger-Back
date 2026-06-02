// models/sequelize/marketing/metaAdSet.js
//
// Nível intermediário da hierarquia Meta: Campanha → Conjunto de Anúncios → Anúncio.
// Cada conjunto define audiência, orçamento e cronograma.

export default (sequelize, DataTypes) => {
  const MetaAdSet = sequelize.define('MetaAdSet', {
    // ── Identificação (Meta) ─────────────────────────────────────────────────
    id:               { type: DataTypes.STRING(40), primaryKey: true },     // meta adset_id
    campaign_id:      { type: DataTypes.STRING(40), allowNull: false },
    name:             { type: DataTypes.STRING(255) },
    status:           { type: DataTypes.STRING(40) },                       // ACTIVE | PAUSED | DELETED | ARCHIVED
    effective_status: { type: DataTypes.STRING(60) },
    optimization_goal: { type: DataTypes.STRING(60) },                      // LEAD_GENERATION | LINK_CLICKS | etc.
    billing_event:    { type: DataTypes.STRING(60) },                       // IMPRESSIONS | LINK_CLICKS | etc.

    start_time:       { type: DataTypes.DATE },
    end_time:         { type: DataTypes.DATE },
    updated_time:     { type: DataTypes.DATE },
    created_time:     { type: DataTypes.DATE },

    daily_budget_cents:    { type: DataTypes.BIGINT },
    lifetime_budget_cents: { type: DataTypes.BIGINT },

    // ── Insights (denormalized) ──────────────────────────────────────────────
    spend:            { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },
    impressions:      { type: DataTypes.INTEGER, defaultValue: 0 },
    clicks:           { type: DataTypes.INTEGER, defaultValue: 0 },
    reach:            { type: DataTypes.INTEGER, defaultValue: 0 },
    ctr:              { type: DataTypes.DECIMAL(7, 4) },
    cpm:              { type: DataTypes.DECIMAL(10, 2) },
    cpc:              { type: DataTypes.DECIMAL(10, 2) },
    meta_leads_total: { type: DataTypes.INTEGER, defaultValue: 0 },

    last_synced_at:   { type: DataTypes.DATE },
  }, {
    tableName: 'meta_adsets',
    underscored: true,
    timestamps: true,
    indexes: [
      { fields: ['campaign_id'] },
    ],
  });

  return MetaAdSet;
};

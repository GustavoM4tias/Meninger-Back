// models/sequelize/marketing/metaAd.js
//
// Anúncios individuais (nível abaixo de campaign na hierarquia Meta).
//   Campanha → Conjunto de Anúncios → Anúncio → Criativo
//
// Cada anúncio tem seu próprio criativo (imagem/vídeo/texto) e — se for Lead Ad
// — está vinculado a um lead_form_id (que bate com MetaLeadForm.id).
//
// Cache local atualizado on-demand via MetaAdService.syncForCampaign().

export default (sequelize, DataTypes) => {
  const MetaAd = sequelize.define('MetaAd', {
    // ── Identificação ────────────────────────────────────────────────────────
    id:           { type: DataTypes.STRING(40), primaryKey: true },    // meta ad_id
    campaign_id:  { type: DataTypes.STRING(40), allowNull: false },    // FK lógica → meta_campaigns.id
    adset_id:     { type: DataTypes.STRING(40) },
    adset_name:   { type: DataTypes.STRING(255) },
    name:         { type: DataTypes.STRING(255) },
    status:       { type: DataTypes.STRING(40) },                      // ACTIVE | PAUSED | ARCHIVED | DELETED
    effective_status: { type: DataTypes.STRING(40) },
    created_time: { type: DataTypes.DATE },
    updated_time: { type: DataTypes.DATE },          // última modificação na Meta (pause/resume/edit)

    // ── Criativo (texto + mídia) ─────────────────────────────────────────────
    creative_id:        { type: DataTypes.STRING(40) },
    creative_thumbnail: { type: DataTypes.STRING(1000) },              // URL da thumbnail (image/video)
    creative_title:     { type: DataTypes.STRING(500) },
    creative_body:      { type: DataTypes.TEXT },
    creative_link_url:  { type: DataTypes.STRING(1000) },              // URL pra onde o ad leva
    creative_image_url: { type: DataTypes.STRING(2000) },
    creative_image_hash: { type: DataTypes.STRING(60) },
    creative_image_hashes: { type: DataTypes.JSONB },        // todos os hashes possíveis
    creative_video_id:  { type: DataTypes.STRING(60) },
    creative_video_url: { type: DataTypes.STRING(2000) },              // URL playable do vídeo
    creative_video_permalink: { type: DataTypes.STRING(2000) },        // permalink no Facebook (fallback)
    creative_object_type: { type: DataTypes.STRING(40) },              // PHOTO | VIDEO | LINK | STATUS | etc.

    // ── Form vinculado (só pra Lead Ads) ─────────────────────────────────────
    lead_form_id: { type: DataTypes.STRING(40) },                      // FK lógica → meta_lead_forms.id

    // ── Insights agregados do período sincronizado ──────────────────────────
    spend:            { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },
    impressions:      { type: DataTypes.INTEGER, defaultValue: 0 },
    clicks:           { type: DataTypes.INTEGER, defaultValue: 0 },
    ctr:              { type: DataTypes.DECIMAL(7, 4) },
    cpm:              { type: DataTypes.DECIMAL(10, 2) },
    cpc:              { type: DataTypes.DECIMAL(10, 2) },
    meta_leads_total: { type: DataTypes.INTEGER, defaultValue: 0 },

    last_synced_at: { type: DataTypes.DATE },
  }, {
    tableName: 'meta_ads',
    underscored: true,
    timestamps: true,
    indexes: [
      { fields: ['campaign_id'] },
      { fields: ['lead_form_id'] },
    ],
  });

  return MetaAd;
};

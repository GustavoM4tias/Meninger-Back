// models/sequelize/marketing/metaLeadForm.js
//
// Cache local dos formulários de Lead Ads da Meta + mapping pra empreendimento
// e mídia. Atualizado on-demand via MetaLeadFormService.syncFromMeta(), que
// chama /me/accounts → /{page-id}/leadgen_forms na Graph API.
//
// O PK é o próprio meta_form_id (string) — facilita o upsert e a busca quando
// um lead chega pelo webhook (já temos o form_id em mãos).

export default (sequelize, DataTypes) => {
  const MetaLeadForm = sequelize.define('MetaLeadForm', {
    // ── Identificação (vem da Meta) ──────────────────────────────────────────
    id:           { type: DataTypes.STRING(40),  primaryKey: true },   // meta_form_id
    page_id:      { type: DataTypes.STRING(40),  allowNull: false },
    page_name:    { type: DataTypes.STRING(255) },
    name:         { type: DataTypes.STRING(255) },                     // nome do form na Meta
    status:       { type: DataTypes.STRING(40) },                      // ACTIVE | ARCHIVED | DELETED | DRAFT
    locale:       { type: DataTypes.STRING(20) },
    created_time: { type: DataTypes.DATE },                            // criação na Meta

    // Questions snapshot — útil pra debugar mapeamento de campos depois.
    questions:    { type: DataTypes.JSONB },                           // [{ key, label, type }]

    // ── Mapping local (o que o usuário configura aqui) ──────────────────────
    // Quando um lead Meta chega com form_id que tem mapping ativo, esses
    // campos sobrescrevem o roteamento (lead vai pra 'routed' direto).
    bound_empreendimentos: { type: DataTypes.JSONB },                  // [int] idempreendimento CV
    midia_slug:            { type: DataTypes.STRING(60) },
    cv_origem:             { type: DataTypes.STRING(4) },              // FB ou IG (default FB se não vier do payload)
    tags:                  { type: DataTypes.JSONB },                  // [string]

    // false desativa o mapping — lead Meta volta a cair em 'held' pra
    // roteamento manual mesmo tendo binding configurado.
    mapping_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

    // ── Sync metadata ────────────────────────────────────────────────────────
    last_synced_at: { type: DataTypes.DATE },
  }, {
    tableName: 'meta_lead_forms',
    underscored: true,
    timestamps: true,
  });

  return MetaLeadForm;
};

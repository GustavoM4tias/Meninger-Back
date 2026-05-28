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

    // Questions snapshot — usado tanto pra exibir as perguntas do form quanto
    // como base pro mapeamento de campos (field_mappings).
    questions:    { type: DataTypes.JSONB },                           // [{ key, label, type }]

    // Mapeamento configurável por form: cada question.key → campo do CV
    // (nome, email, telefone, etc.) ou 'extra' (vai pra extra_fields) ou
    // 'ignore' (não envia). Quando vazio/null, usa auto-detecção do parser.
    //
    // Exemplo: { "full_name": "nome", "qual_seu_telefone": "telefone",
    //            "Tem interesse em quê?": "extra", "marketing_consent": "ignore" }
    field_mappings: { type: DataTypes.JSONB },

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

    // ── Metadados internos (gestão pela equipe) ─────────────────────────────
    description:  { type: DataTypes.TEXT },                            // nota interna sobre o form
    priority:     { type: DataTypes.STRING(10), defaultValue: 'normal' }, // low | normal | high
    campaign_ref: { type: DataTypes.STRING(120) },                     // referência curta da campanha (texto livre)

    // ─────────────────────────────────────────────────────────────────────────
    // Não temos start_date/end_date aqui (diferente de LeadForm interno).
    // A data de referência vem da Meta: `created_time` (criação do form).
    // O ciclo de vida é controlado pelo Meta via `status` (ACTIVE/ARCHIVED/DELETED).
    // ─────────────────────────────────────────────────────────────────────────

    // ── UTMs default — aplicados ao lead quando o payload não traz ──────────
    // Útil pra forms Meta que não passam UTMs no clique (orgânico, in-feed).
    default_utm_source:   { type: DataTypes.STRING(120) },
    default_utm_medium:   { type: DataTypes.STRING(120) },
    default_utm_campaign: { type: DataTypes.STRING(120) },
    default_utm_content:  { type: DataTypes.STRING(120) },
    default_utm_term:     { type: DataTypes.STRING(120) },

    // Campos extras a enviar ao CV (key:value). Vão pro raw_payload e podem ser
    // referenciados no CV depois (ex: { corretor_id: 42, situacao: 'quente' }).
    cv_extra_fields: { type: DataTypes.JSONB },

    // ── Sync metadata ────────────────────────────────────────────────────────
    last_synced_at: { type: DataTypes.DATE },
  }, {
    tableName: 'meta_lead_forms',
    underscored: true,
    timestamps: true,
  });

  return MetaLeadForm;
};

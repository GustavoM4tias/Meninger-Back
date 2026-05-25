// models/sequelize/marketing/marketingConfig.js
//
// Configuração singleton da captação de marketing (id = 1).
// Migra os flags operacionais e credenciais do .env pra UI:
//   - dry_run, retry config, rate limit (geral)
//   - credenciais Meta Lead Ads (encriptadas via utils/encryption.js)
// Os serviços leem com fallback pro .env quando a DB ainda não tem valor.

export default (sequelize, DataTypes) => {
  const MarketingConfig = sequelize.define('MarketingConfig', {
    id: { type: DataTypes.INTEGER, primaryKey: true, defaultValue: 1 },

    // ── Geral / dispatch ─────────────────────────────────────────────────────
    dry_run: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    retry_max_attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 6 },
    form_rate_limit_per_min: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 10 },

    // ── CV CRM ───────────────────────────────────────────────────────────────
    cv_leads_endpoint: { type: DataTypes.STRING(200), defaultValue: '/v1/comercial/leads' },

    // ── Meta Lead Ads ────────────────────────────────────────────────────────
    meta_app_id:             { type: DataTypes.STRING(100) },
    meta_app_secret_enc:     { type: DataTypes.TEXT },
    meta_verify_token_enc:   { type: DataTypes.TEXT },
    meta_access_token_enc:   { type: DataTypes.TEXT },
    meta_graph_api_version:  { type: DataTypes.STRING(10), defaultValue: 'v21.0' },

    // ── Saúde da integração Meta ─────────────────────────────────────────────
    meta_last_health_at:      { type: DataTypes.DATE },
    meta_last_health_ok:      { type: DataTypes.BOOLEAN },
    meta_last_health_error:   { type: DataTypes.TEXT },
    meta_last_health_payload: { type: DataTypes.JSONB },
  }, {
    tableName: 'marketing_configs',
    underscored: true,
    timestamps: true,
  });

  return MarketingConfig;
};

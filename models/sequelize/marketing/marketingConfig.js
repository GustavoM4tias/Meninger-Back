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
    // Default segue o env: sem MARKETING_CAPTURE_DRY_RUN=true, nasce AO VIVO
    // (Office é o caminho principal pro CV). Um ambiente que queira modo sombra
    // seta o env. O valor efetivo é editável na tela de Configurações.
    dry_run: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: process.env.MARKETING_CAPTURE_DRY_RUN === 'true' },
    retry_max_attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 6 },
    form_rate_limit_per_min: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 10 },

    // ── CV CRM ───────────────────────────────────────────────────────────────
    cv_leads_endpoint: { type: DataTypes.STRING(200), defaultValue: '/v1/comercial/leads' },

    // ── Retorno de lead (nova conversão em lead que já existe) ───────────────
    // Corte da régua de faixas: situação com `ordem` >= este valor é BLINDADA
    // (não se mexe em etapa nem em dono). 4 = "Lead Qualificado" no CV de hoje.
    // Ver services/marketing/cvLeadWorkflow.js.
    lead_return_ordem_blindada: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 4 },

    // Retorno automático quando a pessoa converte num empreendimento novo:
    // solta o dono, volta para a etapa inicial e manda para a fila do
    // empreendimento. Só age fora das etapas de qualificação.
    lead_return_auto: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

    // ── Meta Lead Ads ────────────────────────────────────────────────────────
    meta_app_id:             { type: DataTypes.STRING(100) },
    meta_app_secret_enc:     { type: DataTypes.TEXT },
    meta_verify_token_enc:   { type: DataTypes.TEXT },
    meta_access_token_enc:   { type: DataTypes.TEXT },
    meta_graph_api_version:  { type: DataTypes.STRING(10), defaultValue: 'v21.0' },

    // ── Alertas ──────────────────────────────────────────────────────────────
    // IDs de usuário que recebem os alertas da captação (vínculo faltando,
    // dead-letter, webhook rejeitando, token expirando). null/[] = fallback
    // para todos os admins ativos.
    alert_recipient_user_ids: { type: DataTypes.JSONB },

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

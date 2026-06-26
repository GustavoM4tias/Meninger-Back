// models/sequelize/meta/metaAppConfig.js
//
// Credenciais de NÍVEL DE APP do Meta, compartilhadas por TODAS as integrações
// que usam o mesmo App (WhatsApp Cloud API + Meta Lead Ads). Singleton (id = 1).
//
// Só mora aqui o que é genuinamente do App (idêntico nos dois): App ID, App
// Secret e versão da Graph API. Tokens de acesso e verify tokens são DIFERENTES
// por produto e continuam em whatsapp_configs / marketing_configs.

export default (sequelize, DataTypes) => {
  const MetaAppConfig = sequelize.define('MetaAppConfig', {
    id: { type: DataTypes.INTEGER, primaryKey: true, defaultValue: 1 },

    meta_app_id:            { type: DataTypes.STRING(100) },
    meta_app_secret_enc:    { type: DataTypes.TEXT },                 // AES-256-CBC
    // Sem default: null até ser configurado. Só sobrepõe os módulos quando setado.
    meta_graph_api_version: { type: DataTypes.STRING(10) },

    // Saúde do último teste do App Secret (client_credentials grant).
    last_test_at:    { type: DataTypes.DATE },
    last_test_ok:    { type: DataTypes.BOOLEAN },
    last_test_error: { type: DataTypes.TEXT },
  }, {
    tableName: 'meta_app_configs',
    underscored: true,
    timestamps: true,
  });

  return MetaAppConfig;
};

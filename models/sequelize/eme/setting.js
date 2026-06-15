// models/sequelize/eme/setting.js
//
// Configurações de comportamento do Eme em formato chave -> JSON. Exemplos:
//   identity            -> { name, role, tone, language, greeting }
//   model_pools         -> { fast: [...], smart: [...] }
//   escalation_keywords -> [ ... ]   (palavras que escalam fast -> smart)
//   limits              -> { storage_mb, rate_per_min, rate_per_hour, alert_daily }
//   feature_flags       -> { modules: { financeiro: false, ... } }
// Singleton por chave (upsert por `key`).

export default (sequelize, DataTypes) => {
  const EmeSetting = sequelize.define('EmeSetting', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    key: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    value: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    updatedBy: { type: DataTypes.STRING(120), allowNull: true },
  }, {
    tableName: 'eme_settings',
    underscored: true,
    timestamps: true,
    indexes: [
      { unique: true, fields: ['key'] },
    ],
  });

  return EmeSetting;
};

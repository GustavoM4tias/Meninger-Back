// models/sequelize/eme/configVersion.js
//
// Snapshot completo do cérebro (blocos + glossário + reports + settings) gerado
// a cada publicação. Permite diff e rollback de 1 clique. Apenas uma versão fica
// is_active=true por vez (garantido na camada de serviço, dentro de transação).

export default (sequelize, DataTypes) => {
  const EmeConfigVersion = sequelize.define('EmeConfigVersion', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    label: { type: DataTypes.STRING(200), allowNull: true },

    // Snapshot inteiro do cérebro no momento da publicação.
    payload: { type: DataTypes.JSONB, allowNull: false },

    // draft | published | archived
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'published' },

    // Versão atualmente em vigor (lida pelo runtime). Só uma true por vez.
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    publishedBy: { type: DataTypes.STRING(120), allowNull: true },

    note: { type: DataTypes.TEXT, allowNull: true },
  }, {
    tableName: 'eme_config_versions',
    underscored: true,
    timestamps: true,
    indexes: [
      { fields: ['is_active'] },
      { fields: ['status'] },
      { fields: ['created_at'] },
    ],
  });

  return EmeConfigVersion;
};

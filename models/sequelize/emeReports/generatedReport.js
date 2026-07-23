// models/sequelize/emeReports/generatedReport.js
//
// Relatórios customizados gerados pela Eme (módulo Relatórios).
// NÃO confundir com eme_reports (catálogo de tools do Brain Studio) —
// por isso o prefixo eme_generated_*.
//
// O conteúdo do relatório é o `spec` (JSON de blocos renderizado no front);
// os números vivem em `data_snapshot`. Modos de dados:
//  - fixed : snapshot congelado na publicação (auditável)
//  - live  : período com fim aberto; refresh re-executa as queries (cache TTL)

export default (sequelize, DataTypes) => {
  const EmeGeneratedReport = sequelize.define('EmeGeneratedReport', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    ownerId: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'users', key: 'id' } },

    title: { type: DataTypes.STRING(200), allowNull: false, defaultValue: 'Novo relatório' },

    // Empreendimento principal (opcional; relatório pode ser multi-empreendimento).
    enterpriseName: { type: DataTypes.STRING(200), allowNull: true },

    // draft | published
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },

    // fixed | live
    dataMode: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'fixed' },
    periodStart: { type: DataTypes.DATEONLY, allowNull: true },
    periodEnd: { type: DataTypes.DATEONLY, allowNull: true }, // null = aberto ("até hoje")

    // private | internal | public
    visibility: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'private' },

    // Link público: token CSPRNG + vencimento OBRIGATÓRIO quando público.
    publicToken: { type: DataTypes.STRING(64), allowNull: true, unique: true },
    publicExpiresAt: { type: DataTypes.DATE, allowNull: true },
    publicViews: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    // Tema visual do relatório (ver front: components/Reports/themes.js):
    // classic | modern | executive | vibrant | nature | minimal
    theme: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'classic' },

    // Spec de blocos ({ version, blocks: [{ id, type, props }] }).
    spec: { type: DataTypes.JSONB, allowNull: false, defaultValue: { version: 1, blocks: [] } },

    // Resultado das tools de dados usadas (por chave), para auditoria/refresh.
    dataSnapshot: { type: DataTypes.JSONB, allowNull: true },
    refreshedAt: { type: DataTypes.DATE, allowNull: true },

    // Versão publicada corrente (espelho de eme_generated_report_versions.version).
    publishedVersion: { type: DataTypes.INTEGER, allowNull: true },
    publishedAt: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'eme_generated_reports',
    underscored: true,
    timestamps: true,
    indexes: [
      { fields: ['owner_id'] },
      { fields: ['status'] },
      { fields: ['visibility'] },
      { unique: true, fields: ['public_token'] },
    ],
  });

  EmeGeneratedReport.associate = (models) => {
    EmeGeneratedReport.belongsTo(models.User, { foreignKey: 'owner_id', as: 'owner' });
    EmeGeneratedReport.hasMany(models.EmeGeneratedReportVersion, { foreignKey: 'report_id', as: 'versions' });
    EmeGeneratedReport.hasMany(models.EmeGeneratedReportMessage, { foreignKey: 'report_id', as: 'chatMessages' });
    EmeGeneratedReport.hasMany(models.EmeGeneratedReportAccess, { foreignKey: 'report_id', as: 'accessList' });
  };

  return EmeGeneratedReport;
};

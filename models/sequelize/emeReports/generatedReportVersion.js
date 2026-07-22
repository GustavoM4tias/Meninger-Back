// Histórico de versões publicadas de um relatório gerado pela Eme.

export default (sequelize, DataTypes) => {
  const EmeGeneratedReportVersion = sequelize.define('EmeGeneratedReportVersion', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    reportId: { type: DataTypes.UUID, allowNull: false, references: { model: 'eme_generated_reports', key: 'id' } },
    version: { type: DataTypes.INTEGER, allowNull: false },
    spec: { type: DataTypes.JSONB, allowNull: false },
    dataSnapshot: { type: DataTypes.JSONB, allowNull: true },
    publishedBy: { type: DataTypes.INTEGER, allowNull: true },
    publishedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'eme_generated_report_versions',
    underscored: true,
    timestamps: false,
    indexes: [
      { unique: true, fields: ['report_id', 'version'] },
    ],
  });

  EmeGeneratedReportVersion.associate = (models) => {
    EmeGeneratedReportVersion.belongsTo(models.EmeGeneratedReport, { foreignKey: 'report_id', as: 'report' });
  };

  return EmeGeneratedReportVersion;
};

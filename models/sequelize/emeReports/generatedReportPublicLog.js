// Auditoria de acessos ao link público (/r/:token) de um relatório.

export default (sequelize, DataTypes) => {
  const EmeGeneratedReportPublicLog = sequelize.define('EmeGeneratedReportPublicLog', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    reportId: { type: DataTypes.UUID, allowNull: false, references: { model: 'eme_generated_reports', key: 'id' } },
    ip: { type: DataTypes.STRING(64), allowNull: true },
    userAgent: { type: DataTypes.STRING(400), allowNull: true },
  }, {
    tableName: 'eme_generated_report_public_log',
    underscored: true,
    timestamps: true,
    updatedAt: false,
    indexes: [
      { fields: ['report_id', 'created_at'] },
    ],
  });

  return EmeGeneratedReportPublicLog;
};

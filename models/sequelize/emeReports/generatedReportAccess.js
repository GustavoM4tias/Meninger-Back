// Lista de acesso interno de um relatório (visibility = internal).
// Cada linha concede acesso a um usuário OU a um cargo (position).

export default (sequelize, DataTypes) => {
  const EmeGeneratedReportAccess = sequelize.define('EmeGeneratedReportAccess', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    reportId: { type: DataTypes.UUID, allowNull: false, references: { model: 'eme_generated_reports', key: 'id' } },
    userId: { type: DataTypes.INTEGER, allowNull: true },
    position: { type: DataTypes.STRING(120), allowNull: true },
  }, {
    tableName: 'eme_generated_report_access',
    underscored: true,
    timestamps: true,
    updatedAt: false,
    indexes: [
      { fields: ['report_id'] },
      { fields: ['user_id'] },
    ],
  });

  EmeGeneratedReportAccess.associate = (models) => {
    EmeGeneratedReportAccess.belongsTo(models.EmeGeneratedReport, { foreignKey: 'report_id', as: 'report' });
  };

  return EmeGeneratedReportAccess;
};

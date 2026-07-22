// Thread de conversa com a Eme de um relatório (o contexto vive no relatório,
// não na sessão global do chat — sair e voltar retoma de onde parou).

export default (sequelize, DataTypes) => {
  const EmeGeneratedReportMessage = sequelize.define('EmeGeneratedReportMessage', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    reportId: { type: DataTypes.UUID, allowNull: false, references: { model: 'eme_generated_reports', key: 'id' } },
    role: { type: DataTypes.STRING(10), allowNull: false }, // user | model
    content: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    // Tools executadas no turno: [{ name, args, ok, summary }]
    toolCalls: { type: DataTypes.JSONB, allowNull: true },
  }, {
    tableName: 'eme_generated_report_messages',
    underscored: true,
    timestamps: true,
    updatedAt: false,
    indexes: [
      { fields: ['report_id', 'created_at'] },
    ],
  });

  EmeGeneratedReportMessage.associate = (models) => {
    EmeGeneratedReportMessage.belongsTo(models.EmeGeneratedReport, { foreignKey: 'report_id', as: 'report' });
  };

  return EmeGeneratedReportMessage;
};

// Relatórios que o destinatário tirou da própria lista.
//
// Existe porque o acesso pode vir por CARGO — nesse caso não há linha
// individual para remover em eme_generated_report_access, e o destinatário
// ficaria preso a um relatório que não lhe interessa. O dismissal é pessoal:
// não afeta o acesso dos outros nem o do dono.
//
// Se o dono compartilhar DE NOVO com essa pessoa depois, o dismissal é
// limpo e o relatório volta a aparecer (é um novo convite, não o antigo).

export default (sequelize, DataTypes) => {
  const EmeGeneratedReportDismissal = sequelize.define('EmeGeneratedReportDismissal', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    reportId: { type: DataTypes.UUID, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
  }, {
    tableName: 'eme_generated_report_dismissals',
    underscored: true,
    timestamps: true,
    updatedAt: false,
    indexes: [
      { unique: true, fields: ['report_id', 'user_id'] },
      { fields: ['user_id'] },
    ],
  });

  return EmeGeneratedReportDismissal;
};

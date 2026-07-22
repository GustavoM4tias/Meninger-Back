// Pipeline de promoção de blocos: registra cada custom-html gerado pela Eme
// para o admin acompanhar reuso e decidir promover a bloco oficial do catálogo.

export default (sequelize, DataTypes) => {
  const EmeGeneratedReportCustomBlock = sequelize.define('EmeGeneratedReportCustomBlock', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    // SHA-256 do HTML normalizado — agrupa reusos do "mesmo" bloco.
    contentHash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    html: { type: DataTypes.TEXT, allowNull: false },
    // Descrição do que o bloco faz (a Eme informa ao criar).
    purpose: { type: DataTypes.STRING(400), allowNull: true },
    useCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    lastReportId: { type: DataTypes.UUID, allowNull: true },
    // em_uso | promovido | descartado
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'em_uso' },
    reviewNote: { type: DataTypes.TEXT, allowNull: true },
  }, {
    tableName: 'eme_generated_report_custom_blocks',
    underscored: true,
    timestamps: true,
    indexes: [
      { unique: true, fields: ['content_hash'] },
      { fields: ['status'] },
    ],
  });

  return EmeGeneratedReportCustomBlock;
};

// Memória dos relatórios da Eme.
//
// Guarda o "jeito de fazer" que o usuário quer: estrutura preferida, tom,
// recortes que sempre entram (ou nunca), regras de negócio a respeitar.
// A Eme lê essas memórias no início de cada conversa e pode gravar novas
// quando o usuário expressa uma preferência.
//
// Escopo:
//   report_id preenchido → vale só naquele relatório
//   report_id NULL       → vale em TODOS os relatórios daquele usuário

export default (sequelize, DataTypes) => {
  const EmeGeneratedReportMemory = sequelize.define('EmeGeneratedReportMemory', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    reportId: { type: DataTypes.UUID, allowNull: true },

    text: { type: DataTypes.TEXT, allowNull: false },

    // user = o usuário escreveu/editou | eme = a Eme deduziu da conversa
    source: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'eme' },

    // Quantas conversas já usaram esta memória (sinal de relevância)
    useCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lastUsedAt: { type: DataTypes.DATE, allowNull: true },

    // Memória fixada nunca é podada nem sobrescrita automaticamente
    pinned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  }, {
    tableName: 'eme_generated_report_memories',
    underscored: true,
    timestamps: true,
    indexes: [
      { fields: ['user_id'] },
      { fields: ['report_id'] },
    ],
  });

  return EmeGeneratedReportMemory;
};

// models/sequelize/eme/glossaryTerm.js
//
// Glossário do Eme: jargão de voz (STT), vocabulário corporativo e palavras
// proibidas. Injetado no system prompt como tabela de interpretação/estilo.

export default (sequelize, DataTypes) => {
  const EmeGlossaryTerm = sequelize.define('EmeGlossaryTerm', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    // Slug estável para upsert idempotente no seed.
    key: { type: DataTypes.STRING(140), allowNull: false, unique: true },

    // O termo de entrada: o que o usuário fala/escreve errado, ou a palavra a evitar.
    term: { type: DataTypes.STRING(200), allowNull: false },

    // O termo correto/canônico. Para kind='forbidden', é a alternativa sugerida.
    canonical: { type: DataTypes.STRING(200), allowNull: true },

    // voice_stt  — correção de reconhecimento de voz ("líderes" -> "leads")
    // vocabulary — sinônimo/equivalência ("pasta" = pré-cadastro)
    // forbidden  — palavra que a Eme NÃO deve usar ("banco" -> usar "CCA")
    kind: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'vocabulary' },

    context: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'OFFICE' },

    note: { type: DataTypes.TEXT, allowNull: true },

    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

    updatedBy: { type: DataTypes.STRING(120), allowNull: true },
  }, {
    tableName: 'eme_glossary_terms',
    underscored: true,
    timestamps: true,
    indexes: [
      { unique: true, fields: ['key'] },
      { fields: ['kind'] },
      { fields: ['context'] },
      { fields: ['enabled'] },
    ],
  });

  return EmeGlossaryTerm;
};

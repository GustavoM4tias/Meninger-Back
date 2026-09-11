// models/sequelize/eme/embedding.js
//
// Vetor de embedding de um item da Eme que precisa ser achado por
// similaridade: a descrição de uma tool, um bloco do cérebro, um termo do
// glossário. Um registro por (kind, ref_key); `content_hash` diz de qual texto
// o vetor veio - texto mudou, o índice re-embeda sozinho.
//
// Guardado como JSONB (768 floats) e comparado em JS, de propósito: são poucas
// centenas de itens e assim não depende da extensão pgvector, que é opcional
// no servidor (ver ensureAcademySchema.js).

export default (sequelize, DataTypes) => {
    const EmeEmbedding = sequelize.define('EmeEmbedding', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        // tool | block | glossary
        kind: { type: DataTypes.STRING(20), allowNull: false },
        // nome da tool, key do bloco, key do termo
        ref_key: { type: DataTypes.STRING(160), allowNull: false },
        content_hash: { type: DataTypes.STRING(64), allowNull: false },
        model: { type: DataTypes.STRING(60), allowNull: false },
        dims: { type: DataTypes.INTEGER, allowNull: false },
        vector: { type: DataTypes.JSONB, allowNull: false },
    }, {
        tableName: 'eme_embeddings',
        underscored: true,
        timestamps: true,
        indexes: [{ unique: true, fields: ['kind', 'ref_key'] }],
    });

    return EmeEmbedding;
};

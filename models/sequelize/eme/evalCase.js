// models/sequelize/eme/evalCase.js
//
// Um caso do conjunto de avaliação da Eme: a pergunta que uma pessoa faria e o
// que se espera do turno - qual tool, com quais argumentos, e o que o texto
// precisa (ou não pode) dizer. O runner (EmeEvalService) roda a pergunta no
// pipeline REAL do chat e compara.
//
// Gerido pela tela Cérebro da Eme > Avaliação. O seed inicial entra pelo
// ensureEmeRetrievalSchema só quando a tabela está vazia.

export default (sequelize, DataTypes) => {
    const EmeEvalCase = sequelize.define('EmeEvalCase', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        title: { type: DataTypes.STRING(160), allowNull: false },
        // A pergunta, como a pessoa escreveria.
        message: { type: DataTypes.TEXT, allowNull: false },
        // Tool que precisa ter sido chamada (null = não exige tool específica).
        expected_tool: { type: DataTypes.STRING(80), allowNull: true },
        // Subconjunto dos args da chamada esperada: string casa por "contém"
        // sem acento; número/booleano casam por igualdade.
        expected_args: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        // true = o turno NÃO pode chamar tool nenhuma (saudação, conversa).
        expected_no_tool: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        // Trechos que o texto da resposta precisa conter / não pode conter.
        expected_text: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        forbidden_text: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        tags: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        note: { type: DataTypes.TEXT, allowNull: true },
        created_by: { type: DataTypes.STRING(120), allowNull: true },
        updated_by: { type: DataTypes.STRING(120), allowNull: true },
    }, {
        tableName: 'eme_eval_cases',
        underscored: true,
        timestamps: true,
        indexes: [{ fields: ['enabled'] }],
    });

    return EmeEvalCase;
};

export default (sequelize, DataTypes) => {
    const AcademyQuestion = sequelize.define('AcademyQuestion', {
        // Texto da pergunta (pode conter markdown leve).
        text: { type: DataTypes.TEXT, allowNull: false },

        // SINGLE | MULTIPLE
        // SINGLE: aluno escolhe 1 alternativa, correctIndexes tem 1 valor
        // MULTIPLE: aluno escolhe N alternativas, correctIndexes tem >=2 valores
        type: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'SINGLE' },

        // Array de strings: ["São Paulo", "Brasília", "Rio", "Salvador"]
        options: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },

        // Array de índices corretos (sempre array, mesmo para SINGLE).
        // SINGLE com correta=1 → [1]. MULTIPLE com corretas=1,3 → [1, 3].
        // 🔒 Esse campo é PRIVADO — nunca devolvido ao aluno.
        correctIndexes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },

        // Explicação opcional mostrada APÓS o aluno errar/acertar.
        explanation: { type: DataTypes.TEXT, allowNull: true },

        // Taxonomia
        tags: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        // EASY | MEDIUM | HARD
        difficulty: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'MEDIUM' },

        createdByUserId: { type: DataTypes.INTEGER, allowNull: true },
        updatedByUserId: { type: DataTypes.INTEGER, allowNull: true },

        // ACTIVE | ARCHIVED
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ACTIVE' },
    }, {
        tableName: 'academy_questions',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['status'] },
            { fields: ['difficulty'] },
            { fields: ['created_by_user_id'] },
        ],
    });

    AcademyQuestion.associate = (db) => {
        if (db.User) {
            AcademyQuestion.belongsTo(db.User, { foreignKey: 'createdByUserId', as: 'createdBy' });
            AcademyQuestion.belongsTo(db.User, { foreignKey: 'updatedByUserId', as: 'updatedBy' });
        }
    };

    return AcademyQuestion;
};

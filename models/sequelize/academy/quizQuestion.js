export default (sequelize, DataTypes) => {
    const AcademyQuizQuestion = sequelize.define('AcademyQuizQuestion', {
        // Item da trilha (type=QUIZ) que referencia a pergunta.
        itemId: { type: DataTypes.INTEGER, allowNull: false },
        questionId: { type: DataTypes.INTEGER, allowNull: false },
        orderIndex: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
        // Override opcional: pode definir um peso diferente desta pergunta neste quiz
        points: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    }, {
        tableName: 'academy_quiz_questions',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['item_id'] },
            { fields: ['question_id'] },
            { unique: true, fields: ['item_id', 'question_id'], name: 'academy_quiz_questions_item_question_unique' },
        ],
    });

    AcademyQuizQuestion.associate = (db) => {
        AcademyQuizQuestion.belongsTo(db.AcademyTrackItem, { foreignKey: 'itemId', as: 'item' });
        AcademyQuizQuestion.belongsTo(db.AcademyQuestion, { foreignKey: 'questionId', as: 'question' });
    };

    return AcademyQuizQuestion;
};

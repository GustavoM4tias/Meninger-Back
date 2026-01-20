// models/sequelize/academy/userQuizAttempt.js
export default (sequelize, DataTypes) => {
    const AcademyUserQuizAttempt = sequelize.define(
        'AcademyUserQuizAttempt',
        {
            id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },

            userId: {
                type: DataTypes.BIGINT,
                allowNull: false,
                field: 'user_id', // ✅ coluna real
            },

            trackSlug: {
                type: DataTypes.STRING,
                allowNull: false,
                field: 'track_slug', // ✅ coluna real
            },

            itemId: {
                type: DataTypes.BIGINT,
                allowNull: false,
                field: 'item_id', // ✅ coluna real
            },

            answers: {
                type: DataTypes.JSONB,
                allowNull: false,
                defaultValue: {},
                field: 'answers',
            },

            allCorrect: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false,
                field: 'all_correct',
            },

            submittedAt: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: DataTypes.NOW,
                field: 'submitted_at',
            },
        },
        {
            tableName: 'academy_user_quiz_attempts',
            timestamps: true,
            underscored: true, // ✅ garante created_at / updated_at e nome de colunas padrão
            indexes: [
                {
                    unique: true,
                    fields: ['user_id', 'track_slug', 'item_id'], // ✅ colunas do banco
                    name: 'academy_user_quiz_attempts_user_id_track_slug_item_id',
                },
            ],
        }
    );

    return AcademyUserQuizAttempt;
};

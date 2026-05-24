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

            // S2.3: número da tentativa (1, 2, 3...) — incremental por (user, track, item).
            attemptNumber: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 1,
                field: 'attempt_number',
            },

            // S2.3: nota em % (0-100). allCorrect = scorePercent === 100.
            // passed = scorePercent >= passingScore (calculado no service).
            scorePercent: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 0,
                field: 'score_percent',
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
                { fields: ['user_id'] },
                { fields: ['track_slug'] },
                { fields: ['item_id'] },
                // S2.3: ATENÇÃO — antes era UNIQUE (user_id, track_slug, item_id), forçando UPSERT
                // em cima da mesma linha. Agora permitimos múltiplas tentativas, e a UNIQUE
                // virou (user_id, track_slug, item_id, attempt_number) para garantir que
                // attempt_number é único por (user, item).
                {
                    unique: true,
                    fields: ['user_id', 'track_slug', 'item_id', 'attempt_number'],
                    name: 'academy_user_quiz_attempts_user_track_item_attempt_unique',
                },
            ],
        }
    );

    return AcademyUserQuizAttempt;
};

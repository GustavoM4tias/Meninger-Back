export default (sequelize, DataTypes) => {
    const AcademyXpLog = sequelize.define('AcademyXpLog', {
        userId: { type: DataTypes.INTEGER, allowNull: false },
        // Motivo: TRACK_COMPLETED | ITEM_COMPLETED | QUIZ_PASSED | ARTICLE_PUBLISHED | TOPIC_CREATED | POST_UPVOTED | DAILY_STREAK | COMMENT_POSTED | RATING_GIVEN
        reason: { type: DataTypes.STRING(40), allowNull: false },
        amount: { type: DataTypes.INTEGER, allowNull: false },
        // refKind/refId opcionais — para tracking (qual item/post/etc gerou o XP)
        refKind: { type: DataTypes.STRING(40), allowNull: true },
        refId: { type: DataTypes.STRING, allowNull: true },
    }, {
        tableName: 'academy_xp_logs',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['user_id'] },
            { fields: ['user_id', 'created_at'] },
            { fields: ['reason'] },
            // UNIQUE com COALESCE de NULLs é criado via ensureAcademySchema (sync alter
            // do Sequelize não suporta expressões em índices).
        ],
    });

    return AcademyXpLog;
};

export default (sequelize, DataTypes) => {
    const AcademyRating = sequelize.define('AcademyRating', {
        // Polimórfico: ARTICLE | TRACK
        // (depois pode expandir para POST, MODULE, etc.)
        targetType: { type: DataTypes.STRING(20), allowNull: false },

        // Identificador do alvo (string para uniformizar):
        // ARTICLE → article.id
        // TRACK   → track.slug
        targetRef: { type: DataTypes.STRING, allowNull: false },

        userId: { type: DataTypes.INTEGER, allowNull: false },

        // 1..5 estrelas
        stars: { type: DataTypes.INTEGER, allowNull: false },

        // Comentário opcional (review)
        comment: { type: DataTypes.TEXT, allowNull: true },
    }, {
        tableName: 'academy_ratings',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['target_type', 'target_ref'] },
            { fields: ['user_id'] },
            {
                unique: true,
                fields: ['user_id', 'target_type', 'target_ref'],
                name: 'academy_ratings_user_target_unique',
            },
        ],
    });

    AcademyRating.associate = (db) => {
        if (db.User) {
            AcademyRating.belongsTo(db.User, { foreignKey: 'userId', as: 'user' });
        }
    };

    return AcademyRating;
};

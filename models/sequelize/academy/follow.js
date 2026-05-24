export default (sequelize, DataTypes) => {
    const AcademyFollow = sequelize.define('AcademyFollow', {
        // Quem segue.
        followerId: { type: DataTypes.INTEGER, allowNull: false },

        // Tipo do alvo: USER | TRACK | TOPIC | CATEGORY
        // USER     → targetRef = userId (numérico, mas guardamos string pra uniformidade)
        // TRACK    → targetRef = slug
        // TOPIC    → targetRef = topicId
        // CATEGORY → targetRef = categorySlug (KB ou COMMUNITY)
        targetType: { type: DataTypes.STRING(20), allowNull: false },

        // Identificador do alvo (depende do tipo). String pra unificar.
        targetRef: { type: DataTypes.STRING, allowNull: false },
    }, {
        tableName: 'academy_follows',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['follower_id'] },
            { fields: ['target_type', 'target_ref'] },
            {
                unique: true,
                fields: ['follower_id', 'target_type', 'target_ref'],
                name: 'academy_follows_follower_target_unique',
            },
        ],
    });

    AcademyFollow.associate = (db) => {
        if (db.User) {
            AcademyFollow.belongsTo(db.User, { foreignKey: 'followerId', as: 'follower' });
        }
    };

    return AcademyFollow;
};

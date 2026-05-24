export default (sequelize, DataTypes) => {
    const AcademyPostUpvote = sequelize.define('AcademyPostUpvote', {
        postId: { type: DataTypes.INTEGER, allowNull: false },
        userId: { type: DataTypes.INTEGER, allowNull: false },
    }, {
        tableName: 'academy_post_upvotes',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['post_id'] },
            { fields: ['user_id'] },
            {
                unique: true,
                fields: ['post_id', 'user_id'],
                name: 'academy_post_upvotes_post_user_unique',
            },
        ],
    });

    AcademyPostUpvote.associate = (db) => {
        AcademyPostUpvote.belongsTo(db.AcademyPost, { foreignKey: 'postId', as: 'post' });
        if (db.User) {
            AcademyPostUpvote.belongsTo(db.User, { foreignKey: 'userId', as: 'user' });
        }
    };

    return AcademyPostUpvote;
};

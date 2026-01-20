export default (sequelize, DataTypes) => {
    const AcademyPost = sequelize.define('AcademyPost', {
        topicId: { type: DataTypes.INTEGER, allowNull: false },

        // markdown/token body
        body: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },

        // payload TokenEditor (embeds/widgets)
        payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },

        createdByUserId: { type: DataTypes.INTEGER, allowNull: true },
        updatedByUserId: { type: DataTypes.INTEGER, allowNull: true },

        // ANSWER | COMMENT
        type: { type: DataTypes.STRING, allowNull: false, defaultValue: 'ANSWER' },

        upvotes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    }, {
        tableName: 'academy_posts',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['topic_id'] },
            { fields: ['type'] },
        ],
    });

    AcademyPost.associate = (db) => {
        AcademyPost.belongsTo(db.AcademyTopic, { foreignKey: 'topicId', as: 'topic' });

        if (db.User) {
            AcademyPost.belongsTo(db.User, { foreignKey: 'createdByUserId', as: 'createdBy' });
            AcademyPost.belongsTo(db.User, { foreignKey: 'updatedByUserId', as: 'updatedBy' });
        }
    };

    return AcademyPost;
};

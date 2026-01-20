export default (sequelize, DataTypes) => {
    const AcademyPost = sequelize.define(
        'AcademyPost',
        {
            topicId: { type: DataTypes.INTEGER, allowNull: false },

            // markdown tokens
            body: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },

            // payload do TokenEditor (embeds/widgets)
            payload: { type: DataTypes.JSONB, allowNull: true },

            createdByUserId: { type: DataTypes.INTEGER, allowNull: true },
            updatedByUserId: { type: DataTypes.INTEGER, allowNull: true },

            // ANSWER | COMMENT
            type: { type: DataTypes.STRING, allowNull: false, defaultValue: 'ANSWER' },

            upvotes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        },
        {
            tableName: 'academy_posts',
            timestamps: true,
            underscored: true,
            indexes: [
                { fields: ['topic_id'] },
                { fields: ['type'] },
                { fields: ['created_by_user_id'] },
                { fields: ['updated_by_user_id'] },
            ],
        }
    );

    AcademyPost.associate = (db) => {
        AcademyPost.belongsTo(db.AcademyTopic, { foreignKey: 'topicId', as: 'topic' });
    };

    return AcademyPost;
};

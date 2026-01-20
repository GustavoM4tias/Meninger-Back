export default (sequelize, DataTypes) => {
    const AcademyTopic = sequelize.define(
        'AcademyTopic',
        {
            title: { type: DataTypes.STRING, allowNull: false },

            // QUESTION | DISCUSSION | SUGGESTION | INCIDENT
            type: { type: DataTypes.STRING, allowNull: false, defaultValue: 'QUESTION' },

            // OPEN | CLOSED
            status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'OPEN' },

            audience: { type: DataTypes.STRING, allowNull: false, defaultValue: 'BOTH' },

            // categoria fixa (select)
            categorySlug: { type: DataTypes.STRING, allowNull: true },

            // tags livres por palavra
            tags: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },

            createdByUserId: { type: DataTypes.INTEGER, allowNull: true },
            updatedByUserId: { type: DataTypes.INTEGER, allowNull: true },

            acceptedPostId: { type: DataTypes.INTEGER, allowNull: true },
            acceptedByUserId: { type: DataTypes.INTEGER, allowNull: true },

            closedByUserId: { type: DataTypes.INTEGER, allowNull: true },
        },
        {
            tableName: 'academy_topics',
            timestamps: true,
            underscored: true,
            indexes: [
                { fields: ['type'] },
                { fields: ['status'] },
                { fields: ['audience'] },
                { fields: ['category_slug'] },
                { fields: ['created_by_user_id'] },
                { fields: ['updated_by_user_id'] },
            ],
        }
    );

    return AcademyTopic;
};

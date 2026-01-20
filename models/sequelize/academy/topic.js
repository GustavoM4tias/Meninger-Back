export default (sequelize, DataTypes) => {
    const AcademyTopic = sequelize.define('AcademyTopic', {
        title: { type: DataTypes.STRING, allowNull: false },

        // QUESTION | DISCUSSION | SUGGESTION | INCIDENT
        type: { type: DataTypes.STRING, allowNull: false, defaultValue: 'QUESTION' },

        // OPEN | CLOSED
        status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'OPEN' },

        audience: { type: DataTypes.STRING, allowNull: false, defaultValue: 'BOTH' },

        // categoria fixa via select (slug)
        categorySlug: { type: DataTypes.STRING, allowNull: false, defaultValue: 'geral' },

        // tags livres (palavras)
        tags: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },

        createdByUserId: { type: DataTypes.INTEGER, allowNull: true },
        updatedByUserId: { type: DataTypes.INTEGER, allowNull: true },

        acceptedPostId: { type: DataTypes.INTEGER, allowNull: true },
        acceptedByUserId: { type: DataTypes.INTEGER, allowNull: true },
        acceptedAt: { type: DataTypes.DATE, allowNull: true },

        closedByUserId: { type: DataTypes.INTEGER, allowNull: true },
        closedAt: { type: DataTypes.DATE, allowNull: true },
    }, {
        tableName: 'academy_topics',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['type'] },
            { fields: ['status'] },
            { fields: ['audience'] },
            { fields: ['category_slug'] },
        ],
    });

    AcademyTopic.associate = (db) => {
        // se existir db.User
        if (db.User) {
            AcademyTopic.belongsTo(db.User, { foreignKey: 'createdByUserId', as: 'createdBy' });
            AcademyTopic.belongsTo(db.User, { foreignKey: 'updatedByUserId', as: 'updatedBy' });
            AcademyTopic.belongsTo(db.User, { foreignKey: 'closedByUserId', as: 'closedBy' });
            AcademyTopic.belongsTo(db.User, { foreignKey: 'acceptedByUserId', as: 'acceptedBy' });
        }
    };

    return AcademyTopic;
};

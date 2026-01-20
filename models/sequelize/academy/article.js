export default (sequelize, DataTypes) => {
    const AcademyArticle = sequelize.define('AcademyArticle', {
        title: { type: DataTypes.STRING, allowNull: false },
        slug: { type: DataTypes.STRING, allowNull: false, unique: true },
        categorySlug: { type: DataTypes.STRING, allowNull: false },
        audience: { type: DataTypes.STRING, allowNull: false, defaultValue: 'BOTH' },
        status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'DRAFT' },
        body: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
        payload: { type: DataTypes.JSONB, allowNull: true },

        createdByUserId: { type: DataTypes.INTEGER, allowNull: true },
        updatedByUserId: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'academy_articles',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['slug'], unique: true },
            { fields: ['category_slug'] },
            { fields: ['audience'] },
            { fields: ['status'] },
            { fields: ['created_by_user_id'] },
            { fields: ['updated_by_user_id'] },
        ],
    });

    AcademyArticle.associate = (models) => {
        // ajuste o nome do model conforme o seu projeto (User / Users)
        const User = models.User || models.Users;

        AcademyArticle.belongsTo(User, {
            as: 'createdBy',
            foreignKey: 'createdByUserId',
        });

        AcademyArticle.belongsTo(User, {
            as: 'updatedBy',
            foreignKey: 'updatedByUserId',
        });
    };

    return AcademyArticle;
};

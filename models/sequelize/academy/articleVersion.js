export default (sequelize, DataTypes) => {
    const AcademyArticleVersion = sequelize.define('AcademyArticleVersion', {
        articleId: { type: DataTypes.INTEGER, allowNull: false },
        versionNumber: { type: DataTypes.INTEGER, allowNull: false },

        // Snapshot do conteúdo no momento da versão.
        title: { type: DataTypes.STRING, allowNull: false },
        slug: { type: DataTypes.STRING, allowNull: false },
        categorySlug: { type: DataTypes.STRING, allowNull: false },
        body: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
        payload: { type: DataTypes.JSONB, allowNull: true },

        // Status da versão (snapshot do status do artigo no momento).
        // DRAFT | PUBLISHED — se versão era a publicada na hora do snapshot.
        wasPublished: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

        // Autoria
        createdByUserId: { type: DataTypes.INTEGER, allowNull: true },

        // Mensagem de commit opcional (preenchida pelo admin no momento da edição)
        message: { type: DataTypes.STRING, allowNull: true },
    }, {
        tableName: 'academy_article_versions',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['article_id'] },
            { fields: ['article_id', 'version_number'] },
            { unique: true, fields: ['article_id', 'version_number'], name: 'academy_article_versions_article_version_unique' },
        ],
    });

    AcademyArticleVersion.associate = (db) => {
        AcademyArticleVersion.belongsTo(db.AcademyArticle, { foreignKey: 'articleId', as: 'article' });
        if (db.User) {
            AcademyArticleVersion.belongsTo(db.User, { foreignKey: 'createdByUserId', as: 'createdBy' });
        }
    };

    return AcademyArticleVersion;
};

export default (sequelize, DataTypes) => {
    const AcademyArticleComment = sequelize.define('AcademyArticleComment', {
        articleId: { type: DataTypes.INTEGER, allowNull: false },

        // Threading 1 nível: comentário de raiz (parentId=null) ou reply direto.
        // Não aceitamos reply-to-reply para evitar threads recursivas profundas.
        parentId: { type: DataTypes.INTEGER, allowNull: true },

        userId: { type: DataTypes.INTEGER, allowNull: false },

        body: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },

        // ACTIVE | DELETED — soft delete preserva threads.
        // Body é zerado quando DELETED ("[comentário removido]" via frontend).
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ACTIVE' },

        editedAt: { type: DataTypes.DATE, allowNull: true },
    }, {
        tableName: 'academy_article_comments',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['article_id'] },
            { fields: ['parent_id'] },
            { fields: ['user_id'] },
            { fields: ['status'] },
        ],
    });

    AcademyArticleComment.associate = (db) => {
        AcademyArticleComment.belongsTo(db.AcademyArticle, { foreignKey: 'articleId', as: 'article' });
        AcademyArticleComment.belongsTo(db.AcademyArticleComment, { foreignKey: 'parentId', as: 'parent' });
        if (db.User) {
            AcademyArticleComment.belongsTo(db.User, { foreignKey: 'userId', as: 'user' });
        }
    };

    return AcademyArticleComment;
};

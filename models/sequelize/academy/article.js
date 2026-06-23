export default (sequelize, DataTypes) => {
    const AcademyArticle = sequelize.define('AcademyArticle', {
        title: { type: DataTypes.STRING, allowNull: false },
        slug: { type: DataTypes.STRING, allowNull: false, unique: true },
        categorySlug: { type: DataTypes.STRING, allowNull: false },
        // Subcategoria opcional (2º nível da KB): Comercial > Cartório > artigo.
        subcategorySlug: { type: DataTypes.STRING, allowNull: true },
        audience: { type: DataTypes.STRING, allowNull: false, defaultValue: 'BOTH' },
        status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'DRAFT' },
        body: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
        payload: { type: DataTypes.JSONB, allowNull: true },

        // Apelidos / sinônimos / siglas — usados no auto-link estilo wiki.
        // Ex.: para "Nota Fiscal de Serviço", aliases = ["NFS", "NFS-e"].
        aliases: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },

        // Multi-audience — set de tokens dos públicos que podem ver o artigo.
        // Tokens: INTERNAL | GESTOR | ADMIN | BROKER | REALESTATE | CORRESPONDENT.
        // O enum legacy `audience` segue aqui apenas para compat — todas as
        // queries de leitura passam a usar este campo (audiences ?| ARRAY[...]).
        audiences: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },

        // IDs de usuários internos que PODEM editar este artigo (além do autor).
        // O autor (createdByUserId) e admins sempre podem editar, independente
        // desta lista. Selecionado no editor ao criar/editar.
        editorUserIds: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },

        // Visibilidade por departamento (modelo interno). [] = GERAL (todos);
        // [ids de Department] = só esses departamentos (+ admin) enxergam.
        departmentIds: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },

        // Eme × Processos: digest estruturado + grafo + hash do corpo (gerados
        // 1× no publish pelo academyDigestService). A coluna `embedding`
        // (pgvector) NÃO é atributo Sequelize — é gerenciada via SQL cru.
        aiDigest: { type: DataTypes.JSONB, allowNull: true },
        processMeta: { type: DataTypes.JSONB, allowNull: true },
        digestHash: { type: DataTypes.STRING, allowNull: true },

        createdByUserId: { type: DataTypes.INTEGER, allowNull: true },
        updatedByUserId: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'academy_articles',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['slug'], unique: true },
            { fields: ['category_slug'] },
            { fields: ['subcategory_slug'] },
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

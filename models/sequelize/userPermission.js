// /models/sequelize/userPermission.js
export default (sequelize, DataTypes) => {
    const UserPermission = sequelize.define('UserPermission', {
        userId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            unique: true,
        },
        // LEGADO: lista plana usada até o modelo "perfil vivo + exceções".
        // Mantida para rollback; o backfill (ensureAccessModelSchema) copia
        // para routes_extra uma única vez. Rotas efetivas = (perfil ∪ extra) − removed.
        routes: {
            type: DataTypes.JSON,
            allowNull: false,
            defaultValue: [],
            comment: 'LEGADO - array de rotas liberadas; substituído por routes_extra/routes_removed + permission_profile_id',
        },
        // Exceções POR CIMA do perfil vivo (users.permission_profile_id):
        routes_extra: {
            type: DataTypes.JSON,
            allowNull: false,
            defaultValue: [],
            comment: 'Rotas liberadas além do perfil',
        },
        routes_removed: {
            type: DataTypes.JSON,
            allowNull: false,
            defaultValue: [],
            comment: 'Rotas do perfil negadas para este usuário',
        },
        routes_migrated: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
            comment: 'true depois que o backfill routes→routes_extra rodou (idempotência)',
        },
    }, {
        tableName: 'user_permissions',
        underscored: true,
    });

    UserPermission.associate = (db) => {
        UserPermission.belongsTo(db.User, { foreignKey: 'userId', as: 'user' });
        db.User.hasOne(UserPermission, { foreignKey: 'userId', as: 'permission' });
    };

    return UserPermission;
};

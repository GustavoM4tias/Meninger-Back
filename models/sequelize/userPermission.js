// /models/sequelize/userPermission.js
export default (sequelize, DataTypes) => {
    const UserPermission = sequelize.define('UserPermission', {
        userId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            unique: true,
        },
        routes: {
            type: DataTypes.JSON,
            allowNull: false,
            defaultValue: [],
            comment: 'Array de rotas liberadas para o usuário, ex: ["/comercial/faturamento", "/tools/validator"]',
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

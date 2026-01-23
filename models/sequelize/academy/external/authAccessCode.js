export default (sequelize, DataTypes) => {
    const AuthAccessCode = sequelize.define('AuthAccessCode', {
        user_id: { type: DataTypes.INTEGER, allowNull: false },
        code_hash: { type: DataTypes.STRING(255), allowNull: false },
        expires_at: { type: DataTypes.DATE, allowNull: false },
        used_at: { type: DataTypes.DATE, allowNull: true },
        attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        last_sent_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        ip: { type: DataTypes.STRING(100), allowNull: true },
        user_agent: { type: DataTypes.TEXT, allowNull: true },
    }, {
        tableName: 'auth_access_codes',
        underscored: true,
        timestamps: true,
    });

    AuthAccessCode.associate = (models) => {
        AuthAccessCode.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    };

    return AuthAccessCode;
};

// models/sequelize/comercial/mcmvImportLog.js
export default (sequelize, DataTypes) => {
    const McmvImportLog = sequelize.define('McmvImportLog', {
        id:             { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        user_id:        { type: DataTypes.INTEGER, allowNull: true },
        username:       { type: DataTypes.STRING(50), allowNull: true },
        imported_count: { type: DataTypes.INTEGER, allowNull: false },
    }, {
        tableName: 'mcmv_import_logs',
        underscored: true,
        timestamps: true,
        updatedAt: false,
    });

    return McmvImportLog;
};

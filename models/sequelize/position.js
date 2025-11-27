// /models/sequelize/position.js
export default (sequelize, DataTypes) => {
    const Position = sequelize.define('Position', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        name: { type: DataTypes.STRING(100), allowNull: false, unique: true }, // ex: "Gestor Comercial"
        code: { type: DataTypes.STRING(50), allowNull: false, unique: true },  // ex: "GESTOR_COMERCIAL"
        description: { type: DataTypes.TEXT },
        is_internal: { type: DataTypes.BOOLEAN, defaultValue: true },   // interno x parceiro
        is_partner: { type: DataTypes.BOOLEAN, defaultValue: false },
        active: { type: DataTypes.BOOLEAN, defaultValue: true },
    }, {
        tableName: 'positions',
        underscored: true,
        timestamps: true,
    });

    return Position;
};

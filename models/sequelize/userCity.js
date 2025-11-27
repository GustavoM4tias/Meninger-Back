// /models/sequelize/userCity.js
export default (sequelize, DataTypes) => {
    const UserCity = sequelize.define('UserCity', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        name: { type: DataTypes.STRING(100), allowNull: false, unique: true }, // "Marília", "Bauru"...
        uf: { type: DataTypes.STRING(2), allowNull: true },                  // "SP", "MS" etc (se quiser)
        active: { type: DataTypes.BOOLEAN, defaultValue: true },
    }, {
        tableName: 'user_cities',
        underscored: true,
        timestamps: true,
    });

    return UserCity;
};

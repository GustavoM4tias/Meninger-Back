// src/models/sequelize/landSyncEnterprise.js
export default (sequelize, DataTypes) => {
    const LandSyncEnterprise = sequelize.define(
        'LandSyncEnterprise',
        {
            id: {
                type: DataTypes.INTEGER,
                primaryKey: true,
                autoIncrement: true
            },
            enterprise_id: {
                type: DataTypes.INTEGER,
                allowNull: false
            },
            enterprise_name: {
                type: DataTypes.STRING,
                allowNull: true
            },
            active: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: true
            }
        },
        {
            tableName: 'land_sync_enterprises',
            underscored: true
        }
    );

    return LandSyncEnterprise;
};

// models/sequelize/hiddenDashboardEnterprise.js
export default (sequelize, DataTypes) => {
    const HiddenDashboardEnterprise = sequelize.define(
        'HiddenDashboardEnterprise',
        {
            id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            enterprise_id: { type: DataTypes.INTEGER, allowNull: false },
            enterprise_name: { type: DataTypes.STRING, allowNull: true },
            active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
        },
        {
            tableName: 'hidden_dashboard_enterprises',
            underscored: true
        }
    );
    return HiddenDashboardEnterprise;
};

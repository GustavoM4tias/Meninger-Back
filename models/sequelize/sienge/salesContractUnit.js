export default (sequelize, DataTypes) => {
    const SalesContractUnit = sequelize.define('SalesContractUnit', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        contract_id: { type: DataTypes.BIGINT, allowNull: false },
        unit_id: { type: DataTypes.INTEGER, allowNull: false },
        name: DataTypes.STRING(255),
        main: DataTypes.BOOLEAN,
        participation_percentage: DataTypes.DECIMAL(5, 2)
    }, {
        tableName: 'sales_contract_units',
        underscored: true
    });

    SalesContractUnit.associate = models => {
        SalesContractUnit.belongsTo(models.SalesContract, { foreignKey: 'contract_id', as: 'contract' });
    };

    return SalesContractUnit;
};

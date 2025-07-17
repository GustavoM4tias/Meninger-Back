export default (sequelize, DataTypes) => {
    const SalesContractCustomer = sequelize.define('SalesContractCustomer', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        contract_id: { type: DataTypes.BIGINT, allowNull: false },
        customer_id: { type: DataTypes.INTEGER, allowNull: false },
        name: DataTypes.STRING(255),
        main: DataTypes.BOOLEAN,
        spouse: DataTypes.BOOLEAN,
        participation_percentage: DataTypes.DECIMAL(5, 2)
    }, {
        tableName: 'sales_contract_customers',
        underscored: true
    });

    SalesContractCustomer.associate = models => {
        SalesContractCustomer.belongsTo(models.SalesContract, { foreignKey: 'contract_id', as: 'contract' });
    };

    return SalesContractCustomer;
};

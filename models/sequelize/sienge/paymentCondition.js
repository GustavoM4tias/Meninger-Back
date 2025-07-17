export default (sequelize, DataTypes) => {
    const PaymentCondition = sequelize.define('PaymentCondition', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        contract_id: { type: DataTypes.BIGINT, allowNull: false },
        bearer_id: DataTypes.INTEGER,
        bearer_name: DataTypes.STRING(100),
        indexer_id: DataTypes.INTEGER,
        indexer_name: DataTypes.STRING(100),
        condition_type_id: DataTypes.STRING(10),
        condition_type_name: DataTypes.STRING(100),
        interest_type: DataTypes.CHAR(1),
        match_maturities: DataTypes.BOOLEAN,
        installments_number: DataTypes.INTEGER,
        open_installments_number: DataTypes.INTEGER,
        months_grace_period: DataTypes.INTEGER,
        first_payment_date: DataTypes.DATEONLY,
        base_date: DataTypes.DATEONLY,
        base_date_interest: DataTypes.DATEONLY,
        total_value: DataTypes.DECIMAL(14, 2),
        outstanding_balance: DataTypes.DECIMAL(14, 2),
        interest_percentage: DataTypes.DECIMAL(5, 2),
        total_value_interest: DataTypes.DECIMAL(14, 2),
        amount_paid: DataTypes.DECIMAL(14, 2),
        sequence_id: DataTypes.INTEGER,
        order_number: DataTypes.INTEGER,
        order_number_remade: DataTypes.INTEGER,
        status: DataTypes.STRING(20),
        paid_before_contract_additive: DataTypes.BOOLEAN
    }, {
        tableName: 'payment_conditions',
        underscored: true
    });

    PaymentCondition.associate = models => {
        PaymentCondition.belongsTo(models.SalesContract, { foreignKey: 'contract_id', as: 'contract' });
    };

    return PaymentCondition;
};

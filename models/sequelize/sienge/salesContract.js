export default (sequelize, DataTypes) => {
    const SalesContract = sequelize.define('SalesContract', {
        id: { type: DataTypes.BIGINT, primaryKey: true },
        company_id: { type: DataTypes.INTEGER, allowNull: false },
        company_name: { type: DataTypes.STRING(255), allowNull: false },
        internal_company_id: { type: DataTypes.INTEGER },
        enterprise_id: { type: DataTypes.INTEGER, allowNull: false },
        enterprise_name: { type: DataTypes.STRING(255), allowNull: false },
        number: { type: DataTypes.STRING(50), allowNull: false },
        external_id: { type: DataTypes.STRING(255) },
        correction_type: DataTypes.STRING(50),
        situation: DataTypes.STRING(50),
        discount_type: DataTypes.STRING(50),
        discount_percentage: DataTypes.DECIMAL(5, 2),
        cancellation_reason: { type: DataTypes.TEXT },       // <<-- TEXT agora
        cancellation_date: DataTypes.DATEONLY,
        value: DataTypes.DECIMAL(14, 2),
        total_selling_value: DataTypes.DECIMAL(14, 2),
        contract_date: DataTypes.DATEONLY,
        issue_date: DataTypes.DATEONLY,
        expected_delivery_date: DataTypes.DATEONLY,
        accounting_date: DataTypes.DATEONLY,
        creation_date: DataTypes.DATEONLY,
        last_update_date: DataTypes.DATEONLY,
        contains_remade_installments: DataTypes.BOOLEAN,
        special_clause: { type: DataTypes.TEXT },       // <<-- TEXT
        pro_rata_indexer: DataTypes.DECIMAL(5, 2),
        interest_percentage: DataTypes.DECIMAL(5, 2),
        interest_type: DataTypes.STRING(5),
        fine_rate: DataTypes.DECIMAL(5, 2),
        late_interest_calc_type: DataTypes.CHAR(1),
        daily_late_interest_value: DataTypes.DECIMAL(14, 2),
        total_cancellation_amount: DataTypes.DECIMAL(14, 2),
        receivable_bill_id: DataTypes.BIGINT,
        cancellation_payable_bill_id: DataTypes.BIGINT,
        financial_institution_date: DataTypes.DATEONLY,
        financial_institution_number: DataTypes.STRING(100),
    }, {
        tableName: 'sales_contracts',
        underscored: true
    });

    SalesContract.associate = models => {
        SalesContract.hasMany(models.SalesContractCustomer, { foreignKey: 'contract_id', as: 'customers' });
        SalesContract.hasMany(models.SalesContractUnit, { foreignKey: 'contract_id', as: 'units' });
        SalesContract.hasMany(models.PaymentCondition, { foreignKey: 'contract_id', as: 'paymentConditions' });
        SalesContract.hasMany(models.ContractLink, { foreignKey: 'contract_id', as: 'links' });
    };

    return SalesContract;
};

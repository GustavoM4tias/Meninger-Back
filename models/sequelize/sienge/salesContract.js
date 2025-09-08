// /models/sequelize/sienge/salesContract.js
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
        cancellation_reason: { type: DataTypes.TEXT },
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
        special_clause: { type: DataTypes.TEXT },
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

        // valores do terreno db marlon
        land_value: { type: DataTypes.DECIMAL(14, 2) },
        land_updated_at: { type: DataTypes.DATE }, 
        // ...
        // 👇 novos
        customers: { type: DataTypes.JSONB },           // array bruto
        units: { type: DataTypes.JSONB },               // array bruto
        payment_conditions: { type: DataTypes.JSONB },  // array bruto
        links_json: { type: DataTypes.JSONB },          // array bruto

        // ...
    }, {
        tableName: 'contracts',
        underscored: true
    });

    // Opcional: remover associações se for parar de usar as tabelas filhas.
    // SalesContract.associate = models => { ... };

    return SalesContract;
};


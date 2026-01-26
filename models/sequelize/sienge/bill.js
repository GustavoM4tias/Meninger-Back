// models/sienge/bill.js
export default (sequelize, DataTypes) => {
    const SiengeBill = sequelize.define('SiengeBill', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
        },

        debtor_id: DataTypes.INTEGER,
        creditor_id: DataTypes.INTEGER,
        cost_center_id: DataTypes.INTEGER,

        document_identification_id: DataTypes.STRING(4),
        document_number: DataTypes.STRING(20),
        issue_date: DataTypes.DATEONLY,

        // ✅ parcela atual (ex: 3)
        installment_number: DataTypes.INTEGER,

        // ✅ total de parcelas (ex: 6) - já existia
        installments_number: DataTypes.INTEGER,

        total_invoice_amount: DataTypes.DECIMAL(15, 2),
        discount: DataTypes.DECIMAL(15, 2),
        status: DataTypes.STRING(1),
        origin_id: DataTypes.STRING(2),

        notes: DataTypes.TEXT,

        registered_user_id: DataTypes.STRING,
        registered_by: DataTypes.STRING,
        registered_date: DataTypes.DATE,
        changed_user_id: DataTypes.STRING,
        changed_by: DataTypes.STRING,
        changed_date: DataTypes.DATE,

        access_key_number: DataTypes.STRING,
        tenant_url: DataTypes.STRING,

        departments_json: DataTypes.JSONB,
        main_department_id: DataTypes.INTEGER,
        main_department_name: DataTypes.STRING,

        creditor_json: DataTypes.JSONB,
        links_json: DataTypes.JSONB,
    }, {
        tableName: 'sienge_bills',
        underscored: true,
        indexes: [
            { fields: ['cost_center_id'] },
            { fields: ['debtor_id'] },
            { fields: ['issue_date'] },
            // ✅ novo índice (opcional, mas recomendado)
            { fields: ['installment_number'] },
        ]
    });

    return SiengeBill;
};

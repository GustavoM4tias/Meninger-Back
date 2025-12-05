// models/sienge/bill.js
export default (sequelize, DataTypes) => {
    const SiengeBill = sequelize.define('SiengeBill', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,        // id do Sienge
        },

        // identificação
        debtor_id: DataTypes.INTEGER,       // empresa (company) no Sienge
        creditor_id: DataTypes.INTEGER,
        cost_center_id: DataTypes.INTEGER,  // costCenterId usado na busca

        document_identification_id: DataTypes.STRING(4),
        document_number: DataTypes.STRING(20),
        issue_date: DataTypes.DATEONLY,
        installments_number: DataTypes.INTEGER,

        total_invoice_amount: DataTypes.DECIMAL(15, 2),
        discount: DataTypes.DECIMAL(15, 2),
        status: DataTypes.STRING(1),        // S, N, I
        origin_id: DataTypes.STRING(2),

        notes: DataTypes.TEXT,

        // infos de cadastro / alteração
        registered_user_id: DataTypes.STRING,
        registered_by: DataTypes.STRING,
        registered_date: DataTypes.DATE,
        changed_user_id: DataTypes.STRING,
        changed_by: DataTypes.STRING,
        changed_date: DataTypes.DATE,

        access_key_number: DataTypes.STRING,
        tenant_url: DataTypes.STRING,

        // 🔹 DEPARTAMENTOS – cache local da chamada /departments-cost
        departments_json: DataTypes.JSONB,  // [{ departmentId, departmentName, percentage }, ...]
        main_department_id: DataTypes.INTEGER,
        main_department_name: DataTypes.STRING,

        // 🔹 CREDITOR – cache local da chamada /v1/creditors/{id}
        //     Estrutura no formato retornado pelo Sienge, ex:
        //     {
        //       id, name, tradeName, cnpj, address: { ... }, phones: [...], ...
        //     }
        creditor_json: DataTypes.JSONB,

        // raw links pra reaproveitar se precisar
        links_json: DataTypes.JSONB,
    }, {
        tableName: 'sienge_bills',
        underscored: true,
        indexes: [
            { fields: ['cost_center_id'] },
            { fields: ['debtor_id'] },
            { fields: ['issue_date'] },
            // se quiser, pode adicionar um índice aqui também:
            // { fields: ['creditor_id'] },
        ]
    });

    return SiengeBill;
};

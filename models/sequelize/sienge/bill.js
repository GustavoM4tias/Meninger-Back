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

        // ── Controle de sincronização ────────────────────────────────
        // true = departamentos já foram buscados na API (não rebusca mesmo se departments_json estiver vazio)
        departments_fetched: { type: DataTypes.BOOLEAN, defaultValue: false },
        // Legado: true = installments já foram buscados ao menos uma vez. Mantido por compatibilidade,
        // mas a decisão de re-buscar usa is_settled + installments_synced_at.
        installments_fetched: { type: DataTypes.BOOLEAN, defaultValue: false },

        // ── Status do bill (atualizado no re-sync) ───────────────────
        // true = todas as parcelas liquidadas (pagas/canceladas) OU bill cancelado. Para de re-buscar.
        is_settled: { type: DataTypes.BOOLEAN, defaultValue: false },
        // 'open' | 'paid' | 'cancelled' | 'partial'
        current_status: { type: DataTypes.STRING(20), defaultValue: 'open' },
        // Última vez que /v1/bills/{id}/installments foi consultado
        installments_synced_at: DataTypes.DATE,
        // Última vez que o bill apareceu no fetch /v1/bills (atualização de notes/changedDate/etc.)
        last_full_sync_at: DataTypes.DATE,
    }, {
        tableName: 'sienge_bills',
        underscored: true,
        indexes: [
            // Índices declarados no model para sync({ alter: true }) recriar — os pré-existentes.
            // Os índices das colunas novas (is_settled, current_status, installments_synced_at)
            // ficam SÓ nas migrations: sync({ alter: true }) tenta criar índice ANTES da coluna
            // existir e quebra. Para criá-los manualmente em ambientes sem migrate:
            //   CREATE INDEX sienge_bills_is_settled ON sienge_bills (is_settled);
            //   CREATE INDEX sienge_bills_current_status ON sienge_bills (current_status);
            //   CREATE INDEX sienge_bills_installments_synced_at ON sienge_bills (installments_synced_at);
            { fields: ['cost_center_id'] },
            { fields: ['debtor_id'] },
            { fields: ['issue_date'] },
            { fields: ['installment_number'] },
        ]
    });

    SiengeBill.associate = models => {
        SiengeBill.hasMany(models.SiengeBillInstallment, {
            foreignKey: 'bill_id',
            as: 'installments',
        });
        SiengeBill.hasMany(models.Expense, {
            foreignKey: 'bill_id',
            as: 'expenses',
        });
    };

    return SiengeBill;
};

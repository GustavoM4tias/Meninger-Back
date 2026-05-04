// models/sequelize/comercial/enterpriseConditionModule.js
export default (sequelize, DataTypes) => {
    const EnterpriseConditionModule = sequelize.define('EnterpriseConditionModule', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        condition_id: { type: DataTypes.INTEGER, allowNull: false },

        idetapa: { type: DataTypes.INTEGER, allowNull: true },  // link para CvEnterpriseStage
        module_name: { type: DataTypes.STRING, allowNull: false },
        sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },

        // ── Números do produto ────────────────────────────────────────────────
        total_units: { type: DataTypes.INTEGER },                // auto CV, editável
        min_demand: { type: DataTypes.INTEGER },                 // auto ceil(20%), editável
        min_demand_note: { type: DataTypes.TEXT },

        // ── Avaliação (MCMV) ─────────────────────────────────────────────────
        appraisal_faixas: { type: DataTypes.JSONB, defaultValue: null }, // [{faixa,enabled,appraisal_value,appraisal_ceiling,avg_ticket}]
        appraisal_value: { type: DataTypes.DECIMAL(15, 2) },
        appraisal_ceiling: { type: DataTypes.DECIMAL(15, 2) },  // teto da cidade (legado)
        appraisal_note: { type: DataTypes.TEXT },
        appraisal_file_url: { type: DataTypes.TEXT },

        // ── Preços por módulo ─────────────────────────────────────────────────
        price_table_ids: { type: DataTypes.JSONB, defaultValue: [] },
        manual_price_tables: { type: DataTypes.JSONB, defaultValue: [] }, // [{name,validity_from,validity_to,note}]
        price_premise_note: { type: DataTypes.TEXT },

        // ── Regras de negociação por módulo ───────────────────────────────────
        max_entry_value: { type: DataTypes.DECIMAL(15, 2) },
        rp_installment_value: { type: DataTypes.DECIMAL(15, 2) },
        act_installment_value: { type: DataTypes.DECIMAL(15, 2) },
        min_installment_value: { type: DataTypes.DECIMAL(15, 2) },
        max_installments: { type: DataTypes.INTEGER },
        rp_rule: { type: DataTypes.TEXT },
        installment_until_habite_se: { type: DataTypes.STRING(80) },
        installment_post_habite_se: { type: DataTypes.STRING(80) },
        has_state_subsidy: { type: DataTypes.BOOLEAN, defaultValue: false },
        state_subsidy_note: { type: DataTypes.TEXT },
        state_subsidy_state: { type: DataTypes.STRING(10), allowNull: true },
        state_subsidy_program: { type: DataTypes.STRING(200), allowNull: true },
        state_subsidy_custom_state: { type: DataTypes.STRING(100), allowNull: true },
        state_subsidy_rules: { type: DataTypes.TEXT, allowNull: true },
        state_subsidy_conditions: { type: DataTypes.TEXT, allowNull: true },

        // ── Operacional por módulo ────────────────────────────────────────────
        manager_user_id:   { type: DataTypes.INTEGER,     allowNull: true },
        manager_mode:      { type: DataTypes.STRING(10),  defaultValue: 'sistema' }, // 'sistema' | 'manual'
        manager_name:      { type: DataTypes.STRING(200), allowNull: true },
        manager_email:     { type: DataTypes.STRING(200), allowNull: true },
        manager_phone:     { type: DataTypes.STRING(50),  allowNull: true },
        delivery_deadline_months: { type: DataTypes.INTEGER },
        delivery_deadline_note: { type: DataTypes.TEXT },
        commission_pct: { type: DataTypes.DECIMAL(6, 4) },
        commission_source: { type: DataTypes.STRING(10), defaultValue: 'cv' },
        commission_note: { type: DataTypes.TEXT },
        contract_registration_by: { type: DataTypes.STRING(20), allowNull: true }, // 'cca' | 'menin' | 'outros'
        contract_registered_by_user_id: { type: DataTypes.INTEGER, allowNull: true },
        outros_contact_name: { type: DataTypes.STRING(200), allowNull: true },
        outros_contact_email: { type: DataTypes.STRING(200), allowNull: true },
        outros_contact_phone: { type: DataTypes.STRING(50), allowNull: true },
        cca_company_name: { type: DataTypes.STRING(200), allowNull: true },
        cca_cost: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
        cca_charges_company: { type: DataTypes.BOOLEAN, defaultValue: false },
        correspondent_id: { type: DataTypes.INTEGER, allowNull: true },
        has_digital_cert: { type: DataTypes.BOOLEAN, defaultValue: false },
        digital_cert_provider: { type: DataTypes.STRING },
        digital_cert_contact: { type: DataTypes.STRING },
        digital_cert_has_cost: { type: DataTypes.BOOLEAN, defaultValue: false },
        digital_cert_cost: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
        enterprise_files_url: { type: DataTypes.TEXT, allowNull: true }, // arquivos do empreendimento — gera QR Code
        notes: { type: DataTypes.TEXT },

        // ── Documentação ──────────────────────────────────────────────────────
        cef_package_paid_by:         { type: DataTypes.STRING(20),     allowNull: true }, // 'client' | 'menin'
        cef_package_avg_value:       { type: DataTypes.DECIMAL(12, 2), allowNull: true },
        itbi_exempt:                 { type: DataTypes.BOOLEAN,        allowNull: true, defaultValue: false },
        itbi_avg_value:              { type: DataTypes.DECIMAL(12, 2), allowNull: true },
        itbi_exemption_doc_url:      { type: DataTypes.TEXT,           allowNull: true },
        cartorio_prenotacao_value:   { type: DataTypes.DECIMAL(12, 2), allowNull: true },
        cartorio_registration_value: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
        cartorio_paid_by:            { type: DataTypes.STRING(20),     allowNull: true }, // 'client' | 'menin'

        // ── Snapshot de unidades (congelado ao enviar para autorização) ────────
        unit_snapshot: { type: DataTypes.JSONB, defaultValue: null },
    }, {
        tableName: 'enterprise_condition_modules',
        underscored: true,
        timestamps: true,
        indexes: [
            { fields: ['condition_id'] },
            { fields: ['idetapa'] },
        ]
    });

    EnterpriseConditionModule.associate = (db) => {
        EnterpriseConditionModule.belongsTo(db.EnterpriseCondition, { foreignKey: 'condition_id' });
        // ⚠️ idetapa é uma REFERÊNCIA SOFT para cv_enterprise_stages (tabela espelho do CV CRM).
        // Sem `constraints: false`, sync({alter:true}) recria a FK ON DELETE SET NULL e o
        // CvEnterpriseStage.destroy() do EnterpriseSyncService zera idetapa em cascata.
        // Ver migration 20260502000001-drop-idetapa-fk-from-condition-modules.cjs
        EnterpriseConditionModule.belongsTo(db.CvEnterpriseStage, {
            foreignKey: 'idetapa',
            as: 'stage',
            constraints: false,
        });
        EnterpriseConditionModule.hasMany(db.EnterpriseConditionCampaign, { foreignKey: 'module_id', as: 'campaigns', onDelete: 'SET NULL' });
    };

    return EnterpriseConditionModule;
};

// models/sequelize/comercial/enterpriseCondition.js
export default (sequelize, DataTypes) => {
    const EnterpriseCondition = sequelize.define('EnterpriseCondition', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        idempreendimento: { type: DataTypes.INTEGER, allowNull: false },
        reference_month: { type: DataTypes.DATEONLY, allowNull: false }, // '2026-04-01'
        status: {
            type: DataTypes.ENUM('draft', 'pending_approval', 'approved'),
            defaultValue: 'draft',
            allowNull: false,
        },

        // ── Fluxo de aprovação ────────────────────────────────────────────────
        submitted_at:          { type: DataTypes.DATE, allowNull: true },
        submitted_by:          { type: DataTypes.INTEGER, allowNull: true },   // user.id
        approved_at:           { type: DataTypes.DATE, allowNull: true },
        signature_document_id: { type: DataTypes.INTEGER, allowNull: true },   // FK SignatureDocument.id
        unlocked_at:           { type: DataTypes.DATE, allowNull: true },
        unlocked_by:           { type: DataTypes.INTEGER, allowNull: true },   // user.id
        // Histórico completo de eventos: [{action, user_id, username, at, note}]
        approval_history:      { type: DataTypes.JSONB, defaultValue: [] },

        // ── Prazo de entrega ─────────────────────────────────────────────────
        delivery_deadline_months: { type: DataTypes.INTEGER },          // 24, 36 etc.
        delivery_deadline_note: { type: DataTypes.TEXT },

        // ── Comissão ─────────────────────────────────────────────────────────
        commission_pct: { type: DataTypes.DECIMAL(6, 4) },
        commission_source: { type: DataTypes.STRING(10), defaultValue: 'cv' }, // 'cv' | 'manual'

        // ── Tabelas de preço vinculadas (array de idtabela) ───────────────────
        price_table_ids: { type: DataTypes.JSONB, defaultValue: [] },
        price_premise_note: { type: DataTypes.TEXT },
        manual_price_tables: { type: DataTypes.JSONB, defaultValue: [] }, // [{name,validity_from,validity_to,note}]

        // ── Regras de negociação (nível empresa – módulos podem sobrescrever) ─
        max_entry_value: { type: DataTypes.DECIMAL(15, 2) },
        rp_installment_value: { type: DataTypes.DECIMAL(15, 2) },
        installment_until_habite_se: { type: DataTypes.STRING(80) },    // ex: "INCC"
        installment_post_habite_se: { type: DataTypes.STRING(80) },     // ex: "IPCA + 1% a.m."
        act_installment_value: { type: DataTypes.DECIMAL(15, 2) },
        min_installment_value: { type: DataTypes.DECIMAL(15, 2) },
        max_installments: { type: DataTypes.INTEGER },
        rp_rule: { type: DataTypes.TEXT },
        has_state_subsidy: { type: DataTypes.BOOLEAN, defaultValue: false },
        state_subsidy_note: { type: DataTypes.TEXT },             // legado
        state_subsidy_state: { type: DataTypes.STRING(10), allowNull: true }, // 'ms'|'mt'|'pr'|'sp'|'custom'
        state_subsidy_program: { type: DataTypes.STRING(200), allowNull: true },
        state_subsidy_custom_state: { type: DataTypes.STRING(100), allowNull: true },
        state_subsidy_rules: { type: DataTypes.TEXT, allowNull: true },
        state_subsidy_conditions: { type: DataTypes.TEXT, allowNull: true },

        // ── Benefícios ao cliente ─────────────────────────────────────────────
        pays_cef_package: { type: DataTypes.BOOLEAN, defaultValue: false },
        cef_package_value: { type: DataTypes.DECIMAL(12, 2) },
        cef_package_note: { type: DataTypes.TEXT },
        pays_cartorio: { type: DataTypes.BOOLEAN, defaultValue: false },
        cartorio_value: { type: DataTypes.DECIMAL(12, 2) },
        pays_itbi: { type: DataTypes.BOOLEAN, defaultValue: false },
        itbi_exempt: { type: DataTypes.BOOLEAN, defaultValue: false },
        itbi_value: { type: DataTypes.DECIMAL(12, 2) },
        itbi_note: { type: DataTypes.TEXT },

        // ── Operacional ──────────────────────────────────────────────────────
        has_digital_cert: { type: DataTypes.BOOLEAN, defaultValue: false },
        digital_cert_provider: { type: DataTypes.STRING },
        digital_cert_contact: { type: DataTypes.STRING },
        contract_registration_by: {
            type: DataTypes.STRING(20),   // 'cca' | 'menin' | 'outros'
            allowNull: true,
        },
        contract_registered_by_user_id: { type: DataTypes.INTEGER, allowNull: true }, // office user when menin
        // Contato externo quando contract_registration_by = 'outros'
        outros_contact_name:  { type: DataTypes.STRING(200), allowNull: true },
        outros_contact_email: { type: DataTypes.STRING(200), allowNull: true },
        outros_contact_phone: { type: DataTypes.STRING(50),  allowNull: true },
        cca_company_id: { type: DataTypes.INTEGER, allowNull: true },    // legado
        cca_company_name: { type: DataTypes.STRING(200), allowNull: true }, // nome livre da empresa CCA
        cca_cost: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
        cca_charges_company: { type: DataTypes.BOOLEAN, defaultValue: false },
        manager_user_id: { type: DataTypes.INTEGER, allowNull: true }, // gestor responsável (office user)
        correspondent_id: { type: DataTypes.INTEGER, allowNull: true }, // FK cv_correspondents.idusuario

        // ── Documentos vinculados (nomes/ids dos docs do CV) ─────────────────
        cv_documents: { type: DataTypes.JSONB, defaultValue: [] },

        // ── Imobiliárias (cache; atualizado no sync) ──────────────────────────
        realtors_snapshot: { type: DataTypes.JSONB, defaultValue: [] },

        notes: { type: DataTypes.TEXT },

        created_by: { type: DataTypes.INTEGER },
        updated_by: { type: DataTypes.INTEGER },
    }, {
        tableName: 'enterprise_conditions',
        underscored: true,
        timestamps: true,
        indexes: [
            { fields: ['idempreendimento'] },
            { fields: ['reference_month'] },
            { fields: ['status'] },
            { unique: true, fields: ['idempreendimento', 'reference_month'] },
        ]
    });

    EnterpriseCondition.associate = (db) => {
        EnterpriseCondition.belongsTo(db.CvEnterprise, { foreignKey: 'idempreendimento', as: 'enterprise' });
        EnterpriseCondition.hasMany(db.EnterpriseConditionModule, { foreignKey: 'condition_id', as: 'modules', onDelete: 'CASCADE' });
        EnterpriseCondition.hasMany(db.EnterpriseConditionCampaign, { foreignKey: 'condition_id', as: 'campaigns', onDelete: 'CASCADE' });
        // correspondent_id → idusuario em cv_correspondents
        EnterpriseCondition.belongsTo(db.CvCorrespondent, { foreignKey: 'correspondent_id', targetKey: 'idusuario', as: 'correspondent' });
    };

    return EnterpriseCondition;
};

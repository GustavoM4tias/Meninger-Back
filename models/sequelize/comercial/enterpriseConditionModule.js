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
        appraisal_value: { type: DataTypes.DECIMAL(15, 2) },
        appraisal_ceiling: { type: DataTypes.DECIMAL(15, 2) },  // teto da cidade
        appraisal_note: { type: DataTypes.TEXT },
        appraisal_file_url: { type: DataTypes.TEXT },

        // ── Sobrescritas de regras de negociação (se diferir do nível empresa) ─
        // null = usa o valor da condition pai
        negotiation_overrides: { type: DataTypes.JSONB, defaultValue: null },
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
        EnterpriseConditionModule.belongsTo(db.CvEnterpriseStage, { foreignKey: 'idetapa', as: 'stage' });
    };

    return EnterpriseConditionModule;
};

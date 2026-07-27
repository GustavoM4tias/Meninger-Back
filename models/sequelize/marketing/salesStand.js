export default (sequelize, DataTypes) => {
    // Stand de vendas real. O custo vem AO VIVO do backup do Sienge: soma das
    // baixas de caixa dos títulos apropriados no plano financeiro 20207*
    // ("DESPESAS COM STAND") nos centros de custo vinculados (cost_center_ids).
    // Ao "definir" o stand, o total até ali vira snapshot (construction_value);
    // o gasto que entra depois é recorrente = manutenção.
    const SalesStand = sequelize.define('SalesStand', {
        name: { type: DataTypes.STRING(120), allowNull: false },
        // Stand modelo (categoria) — sales_stand_models.
        model_id: { type: DataTypes.INTEGER, allowNull: true },
        // [cdempreendview, ...] — 1+ centros de custo do Sienge vinculados.
        cost_center_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        // draft (em construção/apuração) | defined (custo de construção fechado)
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
        defined_at: { type: DataTypes.DATE, allowNull: true },
        // Snapshot do custo de construção no momento da definição.
        construction_value: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
        // Fase futura: % do recorrente (manutenção) lançado como custo de marketing.
        maintenance_percent: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
        notes: { type: DataTypes.TEXT, allowNull: true },
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        created_by: { type: DataTypes.INTEGER, allowNull: true },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'sales_stands',
        timestamps: true,
        underscored: true,
        indexes: [{ fields: ['model_id'] }, { fields: ['status'] }],
    });

    SalesStand.associate = (db) => {
        SalesStand.belongsTo(db.SalesStandModel, { foreignKey: 'model_id', as: 'model' });
    };

    return SalesStand;
};

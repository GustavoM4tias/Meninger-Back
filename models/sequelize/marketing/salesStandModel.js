export default (sequelize, DataTypes) => {
    // Stand modelo (categoria) do Stand de Vendas: referência de valor médio e
    // itens que compõem aquele padrão de stand (ex.: contêiner, decorado, loja).
    // Os stands reais (sales_stands) apontam para um modelo via model_id.
    const SalesStandModel = sequelize.define('SalesStandModel', {
        name: { type: DataTypes.STRING(120), allowNull: false },
        description: { type: DataTypes.STRING(300), allowNull: true },
        // Faixa de valor médio de referência do modelo (construção completa): de/até.
        avg_value_min: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
        avg_value_max: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
        // Metragem média do stand (m²).
        avg_area_m2: { type: DataTypes.DECIMAL(8, 2), allowNull: false, defaultValue: 0 },
        // ["Contêiner 12m", "Ar-condicionado", ...] — itens que o stand modelo possui.
        items: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        created_by: { type: DataTypes.INTEGER, allowNull: true },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'sales_stand_models',
        timestamps: true,
        underscored: true,
    });

    SalesStandModel.associate = (db) => {
        SalesStandModel.hasMany(db.SalesStand, { foreignKey: 'model_id', as: 'stands' });
    };

    return SalesStandModel;
};

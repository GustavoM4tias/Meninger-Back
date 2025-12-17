export default (sequelize, DataTypes) => {
  const SalesProjectionLine = sequelize.define('SalesProjectionLine', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    projection_id: { type: DataTypes.INTEGER, allowNull: false },

    // NOVO: chave estável da “linha”
    enterprise_key: { type: DataTypes.STRING(80), allowNull: false },

    // ERP opcional (manual)
    erp_id: { type: DataTypes.STRING, allowNull: true },

    alias_id: { type: DataTypes.STRING, allowNull: false, defaultValue: 'default' },

    year_month: { type: DataTypes.STRING(7), allowNull: false }, // YYYY-MM

    units_target: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    avg_price_target: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },

    enterprise_name_cache: { type: DataTypes.STRING, allowNull: true },

    marketing_pct: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 0 },
    commission_pct: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 0 },

  }, {
    tableName: 'sales_projection_lines',
    underscored: true,
    timestamps: true,
    indexes: [
      { unique: true, fields: ['projection_id', 'enterprise_key', 'alias_id', 'year_month'], name: 'uniq_projection_lines_key' },
      { fields: ['projection_id', 'year_month'], name: 'idx_projection_lines_month' },
    ]
  });

  SalesProjectionLine.associate = (db) => {
    SalesProjectionLine.belongsTo(db.SalesProjection, { foreignKey: 'projection_id', as: 'projection' });
  };

  return SalesProjectionLine;
};

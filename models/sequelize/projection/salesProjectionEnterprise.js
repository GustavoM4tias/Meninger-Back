export default (sequelize, DataTypes) => {
  const SalesProjectionEnterprise = sequelize.define('SalesProjectionEnterprise', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    projection_id: { type: DataTypes.INTEGER, allowNull: false },
    // NOVO
    enterprise_key: { type: DataTypes.STRING(80), allowNull: false },
    // ERP opcional
    erp_id: { type: DataTypes.STRING, allowNull: true },
    alias_id: { type: DataTypes.STRING, allowNull: false, defaultValue: 'default' },
    default_avg_price: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    enterprise_name_cache: { type: DataTypes.STRING, allowNull: true },
    default_marketing_pct: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 0 },
    default_commission_pct: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 0 },
    total_units: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null, },
    manual_city: { type: DataTypes.STRING(120), allowNull: true },
  }, {
    tableName: 'sales_projection_enterprises',
    underscored: true,
    timestamps: true,
    indexes: [
      { unique: true, fields: ['projection_id', 'enterprise_key', 'alias_id'], name: 'uniq_projection_defaults_key' }
    ]
  });

  SalesProjectionEnterprise.associate = (db) => {
    SalesProjectionEnterprise.belongsTo(db.SalesProjection, { foreignKey: 'projection_id', as: 'projection' });
  };

  return SalesProjectionEnterprise;
};

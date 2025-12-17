export default (sequelize, DataTypes) => {
  const SalesProjection = sequelize.define('SalesProjection', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    name: { type: DataTypes.STRING(160), allowNull: false },

    // manter se existe na tabela, mas “deprecated”
    year: { type: DataTypes.INTEGER, allowNull: true },

    is_locked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    created_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    tableName: 'sales_projections',
    underscored: true,
    timestamps: true,
  });

  SalesProjection.associate = (db) => {
    SalesProjection.hasMany(db.SalesProjectionLine, { foreignKey: 'projection_id', as: 'lines' });
    SalesProjection.hasMany(db.SalesProjectionEnterprise, { foreignKey: 'projection_id', as: 'enterprise_defaults' });
    SalesProjection.hasMany(db.SalesProjectionLog, { foreignKey: 'projection_id', as: 'logs' });
  };

  return SalesProjection;
};

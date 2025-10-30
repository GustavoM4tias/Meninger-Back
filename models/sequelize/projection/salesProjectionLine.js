import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
  class SalesProjectionLine extends Model { }
  SalesProjectionLine.init({
    projection_id: { type: DataTypes.INTEGER, allowNull: false },
    erp_id: { type: DataTypes.STRING(64), allowNull: false },
    alias_id: { type: DataTypes.STRING, allowNull: false, defaultValue: 'default' },
    year_month: { type: DataTypes.STRING(7), allowNull: false }, // 'YYYY-MM'
    units_target: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    avg_price_target: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    enterprise_name_cache: { type: DataTypes.STRING(255), allowNull: true },
  }, {
    sequelize,
    modelName: 'SalesProjectionLine',
    tableName: 'sales_projection_lines',
    underscored: true,
    timestamps: true,
    indexes: [
      { unique: true, fields: ['projection_id', 'erp_id', 'alias_id', 'year_month'] },
      { fields: ['projection_id'] },
      { fields: ['erp_id'] },
      { fields: ['alias_id'] },
      { fields: ['year_month'] },
    ],
  });
  return SalesProjectionLine;
};

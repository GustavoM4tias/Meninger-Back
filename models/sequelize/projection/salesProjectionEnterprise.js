// models/sequelize/projection/SalesProjectionEnterprise.js
import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
  class SalesProjectionEnterprise extends Model { }
  SalesProjectionEnterprise.init({
    projection_id: { type: DataTypes.INTEGER, allowNull: false },
    erp_id: { type: DataTypes.STRING(64), allowNull: false },
    alias_id: { type: DataTypes.STRING, allowNull: false, defaultValue: 'default' },
    default_avg_price: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    enterprise_name_cache: { type: DataTypes.STRING(255), allowNull: true },

    // NOVOS
    default_marketing_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
    default_commission_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
  }, {
    sequelize,
    modelName: 'SalesProjectionEnterprise',
    tableName: 'sales_projection_enterprises',
    underscored: true,
    timestamps: true,
    indexes: [
      { unique: true, fields: ['projection_id', 'erp_id', 'alias_id'] },
      { fields: ['projection_id'] },
      { fields: ['erp_id'] },
      { fields: ['alias_id'] },
    ],
  });
  return SalesProjectionEnterprise;
};

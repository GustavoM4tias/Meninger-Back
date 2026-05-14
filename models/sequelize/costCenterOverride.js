// models/sequelize/costCenterOverride.js
//
// Override administrativo de nome exibido para um cost_center_id (empreendimento).
// Quando existe, sobrepõe qualquer nome vindo de enterprise_cities ou herança de CC base.
// Presença = override ativo; remoção do registro = volta ao nome padrão.

export default (sequelize, DataTypes) => {
  const CostCenterOverride = sequelize.define('CostCenterOverride', {
    cost_center_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      allowNull: false,
    },
    display_name: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },
    updated_by: { type: DataTypes.STRING(120), allowNull: true },
  }, {
    tableName: 'cost_center_overrides',
    underscored: true,
    timestamps: true,
  });

  return CostCenterOverride;
};

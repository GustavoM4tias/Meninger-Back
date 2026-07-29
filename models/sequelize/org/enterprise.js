// models/sequelize/org/enterprise.js
//
// Empreendimento UNIFICADO (CV + Sienge) — a unidade de liberação de acesso do
// sistema (enterprise_grants apontam para cá). Populado pela consolidação em
// services/org/enterpriseRegistryService.js a partir de enterprise_cities,
// cv_enterprises e contracts. SEM override manual de cidade: os campos
// name/city/uf são sempre os efetivos vindos das fontes.
//
// pair_status:
//   'paired'   — tem CV e Sienge casados
//   'cv_only'  — só existe no CV (sem centro de custo Sienge conhecido)
//   'erp_only' — só existe no Sienge (centro de custo sem cadastro CV)

export default (sequelize, DataTypes) => {
  const OrgEnterprise = sequelize.define('OrgEnterprise', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    // idempreendimento no CV CRM
    cv_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      unique: true,
    },
    // centro de custo no Sienge (cdempreendview / erp_id do enterprise_cities)
    erp_cost_center_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      unique: true,
    },
    company_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'companies', key: 'id' },
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    city: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
    uf: {
      type: DataTypes.STRING(2),
      allowNull: true,
    },
    // STRING (não ENUM) de propósito: ENUM trava o sync({ alter: true }).
    pair_status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'erp_only',
    },
    active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    cv_payload: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    erp_payload: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    first_seen_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    last_seen_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  }, {
    tableName: 'enterprises',
    underscored: true,
    timestamps: true,
  });

  OrgEnterprise.associate = (db) => {
    OrgEnterprise.belongsTo(db.OrgCompany, { foreignKey: 'company_id', as: 'company' });
    db.OrgCompany.hasMany(OrgEnterprise, { foreignKey: 'company_id', as: 'enterprises' });
  };

  return OrgEnterprise;
};

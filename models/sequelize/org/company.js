// models/sequelize/org/company.js
//
// Empresa (fonte: Sienge/ERP). Registro unificado usado pela tela
// "Sincronização de empresas" e pelos atalhos de liberação de acesso
// ("liberar empresa inteira" expande para grants por empreendimento).
// O id É o id da empresa no Sienge (não autoincrement) — fonte externa.

export default (sequelize, DataTypes) => {
  const OrgCompany = sequelize.define('OrgCompany', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: false,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    cnpj: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    last_seen_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  }, {
    tableName: 'companies',
    underscored: true,
    timestamps: true,
  });

  return OrgCompany;
};

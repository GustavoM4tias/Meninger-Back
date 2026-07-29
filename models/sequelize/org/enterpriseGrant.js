// models/sequelize/org/enterpriseGrant.js
//
// Liberação de acesso a UM empreendimento para UM sujeito:
//   subject_type 'user'    → subject_id = users.id (liberação individual)
//   subject_type 'profile' → subject_id = permission_profiles.id (perfil vivo:
//                            todos os usuários do perfil herdam na hora)
//
// Os atalhos da tela ("empresa inteira", "cidade inteira") EXPANDEM para uma
// linha por empreendimento — a liberação é sempre explícita e auditável.
// Empreendimento novo de uma empresa NÃO entra sozinho em grants existentes.

export default (sequelize, DataTypes) => {
  const EnterpriseGrant = sequelize.define('EnterpriseGrant', {
    subject_type: {
      type: DataTypes.STRING(10),
      allowNull: false,
    },
    subject_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    enterprise_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'enterprises', key: 'id' },
    },
    granted_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
  }, {
    tableName: 'enterprise_grants',
    underscored: true,
    timestamps: true,
    indexes: [
      { unique: true, fields: ['subject_type', 'subject_id', 'enterprise_id'], name: 'uniq_enterprise_grant_subject' },
      { fields: ['enterprise_id'], name: 'idx_enterprise_grant_enterprise' },
      { fields: ['subject_type', 'subject_id'], name: 'idx_enterprise_grant_subject' },
    ],
  });

  EnterpriseGrant.associate = (db) => {
    EnterpriseGrant.belongsTo(db.OrgEnterprise, { foreignKey: 'enterprise_id', as: 'enterprise' });
  };

  return EnterpriseGrant;
};

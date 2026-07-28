// /models/sequelize/permissionProfile.js
export default (sequelize, DataTypes) => {
  const PermissionProfile = sequelize.define('PermissionProfile', {
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    routes: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
    },
    active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    // Vínculo opcional com um departamento: marca este perfil como o conjunto
    // PADRÃO de alçadas de visualização aplicado automaticamente ao ativar um
    // usuário novo daquele departamento. No máximo um perfil por departamento
    // (o controller desvincula os demais ao setar).
    department_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'departments', key: 'id' },
    },
  }, {
    tableName: 'permission_profiles',
    underscored: true,
  });

  return PermissionProfile;
};

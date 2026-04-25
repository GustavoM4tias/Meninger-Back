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
  }, {
    tableName: 'permission_profiles',
    underscored: true,
  });

  return PermissionProfile;
};

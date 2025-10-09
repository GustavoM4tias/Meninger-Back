// /models/sequelize/user.js
import bcrypt from 'bcryptjs';

export default (sequelize, DataTypes) => {
  const User = sequelize.define('User', {
    username: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    password: { type: DataTypes.STRING(255), allowNull: false },
    email: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    position: {
      type: DataTypes.ENUM('Diretor', 'Gerente', 'Financeiro', 'Marketing', 'Comercial'),
      allowNull: false
    },
    city: {
      type: DataTypes.ENUM('Marília', 'Bauru', 'Jacarezinho', 'Guaratinguetá', 'Bady Bassitt', 'Dourados', 'Cuiabá'), // ajuste as cidades válidas
      allowNull: false
    },
    role: {
      type: DataTypes.ENUM('admin', 'manager', 'user'), // ajuste os cargos aqui
      allowNull: false,
      defaultValue: 'user'
    },
    status: { type: DataTypes.BOOLEAN, defaultValue: true },
    birth_date: DataTypes.DATEONLY,
    last_login: DataTypes.DATE,
    manager_id: {  // <- Novo campo
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id'
      },
    },
    microsoft_access_token: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    microsoft_refresh_token: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    microsoft_token_expires_at: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },
    face_enabled: { type: DataTypes.BOOLEAN, defaultValue: false },
    face_template: { type: DataTypes.JSONB }, // [128 floats]
    face_threshold: { type: DataTypes.FLOAT, defaultValue: 0.6 },
    face_last_update: { type: DataTypes.DATE }
  }, {
    tableName: 'users',
    underscored: true,
    timestamps: true,
  });

  User.beforeCreate(u => bcrypt.hash(u.password, 10).then(h => { u.password = h; }));
  User.beforeUpdate(u => u.changed('password') && bcrypt.hash(u.password, 10).then(h => { u.password = h; }));

  User.associate = models => {
    User.belongsTo(models.User, {
      as: 'manager',
      foreignKey: 'manager_id',
    });

    User.hasMany(models.User, {
      as: 'subordinates',
      foreignKey: 'manager_id',
    });
  };

  return User;
};

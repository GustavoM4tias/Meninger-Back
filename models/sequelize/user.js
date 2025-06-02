// /models/sequelize/user.js
import bcrypt from 'bcryptjs';

export default (sequelize, DataTypes) => {
  const User = sequelize.define('User', {
    username:   { type: DataTypes.STRING(50), allowNull: false, unique: true },
    password:   { type: DataTypes.STRING(255), allowNull: false },
    email:      { type: DataTypes.STRING(100),allowNull: false, unique: true },
    position:   DataTypes.STRING,
    city:       DataTypes.STRING,
    status:     { type: DataTypes.BOOLEAN, defaultValue: true },
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
  }, {
    tableName: 'users',
    underscored: true,
    timestamps: true,
  });

  User.beforeCreate(u => bcrypt.hash(u.password, 10).then(h => { u.password = h; }));
  User.beforeUpdate(u => u.changed('password') && bcrypt.hash(u.password, 10).then(h => { u.password = h; }));

  // // Se precisar, associações
  // User.associate = models => {
  //   User.hasMany(models.Favorite, { foreignKey: 'user_id', as: 'favorites' });
  // };
  

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

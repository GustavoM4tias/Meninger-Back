// /models/sequelize/favorite.js
export default (sequelize, DataTypes) => {
  const Favorite = sequelize.define('Favorite', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    router:  { type: DataTypes.STRING(120), allowNull: false },
    section: { type: DataTypes.STRING(120), allowNull: false },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName: 'favorites',
    underscored: true,
    timestamps: false, // gerenciamos created_at manualmente
  });

  return Favorite;
};

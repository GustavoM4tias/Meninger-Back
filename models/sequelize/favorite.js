// /models/sequelize/favorite.js
import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
  class Favorite extends Model {
    static associate(models) {
      // se você quiser, pode descomentar e usar:
      // Favorite.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    }
  }

  Favorite.init({
    user_id:   { type: DataTypes.INTEGER, allowNull: false },
    router:    { type: DataTypes.STRING(50), allowNull: false },
    section:   { type: DataTypes.STRING(50), allowNull: false },
    created_at:{ type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
  }, {
    sequelize,
    modelName: 'Favorite',
    tableName: 'favorites',
    underscored: true,
    timestamps: false  // já temos created_at manual
  });

  return Favorite;
};

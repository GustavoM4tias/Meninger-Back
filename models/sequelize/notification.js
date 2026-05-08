// /models/sequelize/notification.js
import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
  class Notification extends Model {
    static associate(models) {
      Notification.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    }
  }

  Notification.init({
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    type:    { type: DataTypes.STRING(64),  allowNull: false },
    title:   { type: DataTypes.STRING(255), allowNull: false },
    body:    { type: DataTypes.TEXT,        allowNull: true  },
    data:    { type: DataTypes.JSON,        allowNull: false, defaultValue: {} },
    link:    { type: DataTypes.STRING(512), allowNull: true  },
    importance:       { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 5 },
    channel_inapp:    { type: DataTypes.BOOLEAN,  allowNull: false, defaultValue: true  },
    channel_email:    { type: DataTypes.BOOLEAN,  allowNull: false, defaultValue: false },
    channel_whatsapp: { type: DataTypes.BOOLEAN,  allowNull: false, defaultValue: false },
    read_at:    { type: DataTypes.DATE, allowNull: true },
    expires_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    sequelize,
    modelName: 'Notification',
    tableName: 'notifications',
    underscored: true,
    timestamps: false,
  });

  return Notification;
};

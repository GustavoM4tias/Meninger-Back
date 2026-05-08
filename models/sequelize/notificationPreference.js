// /models/sequelize/notificationPreference.js
import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
  class NotificationPreference extends Model {
    static associate(models) {
      NotificationPreference.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    }
  }

  NotificationPreference.init({
    user_id:  { type: DataTypes.INTEGER, allowNull: false },
    type:     { type: DataTypes.STRING(64), allowNull: false },
    inapp:    { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    email:    { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    whatsapp: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    sequelize,
    modelName: 'NotificationPreference',
    tableName: 'notification_preferences',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { unique: true, fields: ['user_id', 'type'], name: 'notification_preferences_user_type_uniq' },
    ],
  });

  return NotificationPreference;
};

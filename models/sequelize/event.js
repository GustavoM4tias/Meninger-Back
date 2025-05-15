// /models/sequelize/event.js
import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
  class Event extends Model {}
  Event.init({
    title:       { type: DataTypes.STRING(255), allowNull: false },
    description: { type: DataTypes.TEXT,        allowNull: false },
    post_date:   { 
      type: DataTypes.DATE, 
      allowNull: false, 
      defaultValue: DataTypes.NOW 
    },
    event_date:  { type: DataTypes.DATE, allowNull: false },
    tags:        DataTypes.JSON,
    images:      DataTypes.JSON,
    address:     DataTypes.JSON,
    created_by:  { type: DataTypes.STRING(255), allowNull: false },
  }, {
    sequelize,
    modelName: 'Event',
    tableName: 'events',
    underscored: true,
    timestamps: false
  });
  return Event;
};

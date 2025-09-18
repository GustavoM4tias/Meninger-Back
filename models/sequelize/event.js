// /models/sequelize/event.js
import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
  class Event extends Model {}
  Event.init({
    title:       { type: DataTypes.STRING(255), allowNull: false },
    description: { type: DataTypes.TEXT,        allowNull: false },
    post_date:   { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    event_date:  { type: DataTypes.DATE, allowNull: false },
    tags:        DataTypes.JSON,
    images:      DataTypes.JSON,
    address:     DataTypes.JSON,

    // DEPRECADO: manter por compatibilidade de leitura, mas não usar mais para escrita
    created_by:  { type: DataTypes.STRING(255), allowNull: true },

    // NOVO: lista de organizadores [{type: 'user'|'external', id?, name, email?}]
    organizers:  { type: DataTypes.JSON, allowNull: false, defaultValue: [] },

    // NOVO: destinatários de notificação
    notify_to:   { 
      type: DataTypes.JSON, // { users: [userId, ...], emails: ["a@b.com", ...] }
      allowNull: false, 
      defaultValue: { users: [], positions: [], emails: [] }
    },
  }, {
    sequelize,
    modelName: 'Event',
    tableName: 'events',
    underscored: true,
    timestamps: false
  });
  return Event;
};

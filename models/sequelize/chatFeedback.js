export default (sequelize, DataTypes) => {
  const ChatFeedback = sequelize.define('ChatFeedback', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    message_id: { type: DataTypes.UUID, allowNull: false },
    session_id: { type: DataTypes.UUID, allowNull: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    rating: { type: DataTypes.ENUM('up', 'down'), allowNull: false },
    comment: { type: DataTypes.TEXT, allowNull: true },
  }, {
    tableName: 'chat_feedback',
    underscored: true,
    timestamps: true,
    indexes: [
      { unique: true, fields: ['message_id', 'user_id'] },
    ],
  });
  return ChatFeedback;
};

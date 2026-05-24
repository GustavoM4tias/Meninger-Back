export default (sequelize, DataTypes) => {
  const ChatSession = sequelize.define('ChatSession', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'users', key: 'id' } },
    title: { type: DataTypes.STRING(255), allowNull: true },
    is_favorited: { type: DataTypes.BOOLEAN, defaultValue: false },
    total_bytes: { type: DataTypes.BIGINT, defaultValue: 0 },
    deleted_at: { type: DataTypes.DATE, allowNull: true },

    // E10: contexto da sessão — OFFICE | ACADEMY.
    // Determinado pelo host de origem (academy.menin.com.br vs menin.com.br)
    // — NÃO confiamos no client. Default OFFICE para retrocompat.
    context: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'OFFICE' },
  }, {
    tableName: 'chat_sessions',
    underscored: true,
    timestamps: true,
    paranoid: false,
  });

  ChatSession.associate = (models) => {
    ChatSession.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    ChatSession.hasMany(models.ChatMessage, { foreignKey: 'session_id', as: 'messages' });
  };

  return ChatSession;
};

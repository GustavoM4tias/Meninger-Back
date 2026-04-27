export default (sequelize, DataTypes) => {
  const ChatMessage = sequelize.define('ChatMessage', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    session_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'chat_sessions', key: 'id' } },
    role: { type: DataTypes.ENUM('user', 'assistant'), allowNull: false },
    // Para role=user: texto puro. Para role=assistant: texto ou JSON serializado da resposta estruturada
    content: { type: DataTypes.TEXT, allowNull: false },
    // 'text' | 'navigate' | 'table' | 'chart' | 'error'
    response_type: { type: DataTypes.STRING(30), defaultValue: 'text' },
    // Metadados extras: filtros usados, rota, modelo Gemini, tokens consumidos
    metadata: { type: DataTypes.JSONB, defaultValue: {} },
    bytes_used: { type: DataTypes.INTEGER, defaultValue: 0 },
  }, {
    tableName: 'chat_messages',
    underscored: true,
    timestamps: true,
    updatedAt: false,
  });

  ChatMessage.associate = (models) => {
    ChatMessage.belongsTo(models.ChatSession, { foreignKey: 'session_id', as: 'session' });
  };

  return ChatMessage;
};

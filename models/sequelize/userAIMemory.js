export default (sequelize, DataTypes) => {
  const UserAIMemory = sequelize.define('UserAIMemory', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'users', key: 'id' } },
    // Chave semântica: 'preferred_enterprise', 'preferred_chart_type', 'frequent_queries', etc.
    key: { type: DataTypes.STRING(100), allowNull: false },
    value: { type: DataTypes.TEXT, allowNull: false },
    // 'preference' | 'context' | 'fact'
    category: { type: DataTypes.STRING(30), defaultValue: 'preference' },
  }, {
    tableName: 'user_ai_memories',
    underscored: true,
    timestamps: true,
    indexes: [{ unique: true, fields: ['user_id', 'key'] }],
  });

  UserAIMemory.associate = (models) => {
    UserAIMemory.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
  };

  return UserAIMemory;
};

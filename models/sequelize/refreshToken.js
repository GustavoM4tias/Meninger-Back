// /models/sequelize/refreshToken.js
//
// Refresh tokens da plataforma (sessão revogável). Guardamos apenas o HASH
// (SHA-256) do token — um vazamento do banco não expõe tokens utilizáveis.
// Rotação a cada uso + detecção de reuso (sinal de roubo) no refreshTokenService.
export default (sequelize, DataTypes) => {
  const RefreshToken = sequelize.define('RefreshToken', {
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    token_hash: { type: DataTypes.STRING(64), allowNull: false }, // sha256 hex
    expires_at: { type: DataTypes.DATE, allowNull: false },
    revoked_at: { type: DataTypes.DATE, allowNull: true },
    replaced_by: { type: DataTypes.STRING(64), allowNull: true }, // hash do token que o substituiu (rotação)
    user_agent: { type: DataTypes.STRING(255), allowNull: true },
    ip: { type: DataTypes.STRING(64), allowNull: true },
  }, {
    tableName: 'refresh_tokens',
    underscored: true,
    timestamps: true,
    indexes: [
      { fields: ['token_hash'] },
      { fields: ['user_id'] },
    ],
  });

  RefreshToken.associate = (models) => {
    RefreshToken.belongsTo(models.User, { foreignKey: 'user_id', onDelete: 'CASCADE' });
  };

  return RefreshToken;
};

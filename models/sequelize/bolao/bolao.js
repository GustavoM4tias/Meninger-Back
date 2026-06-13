// models/sequelize/bolao/bolao.js
// Bolão (pool) — uma competição de palpites. Genérico de propósito para
// reaproveitar em outros torneios (mata-mata da Copa, Brasileirão, etc.).
export default (sequelize, DataTypes) => {
  const Bolao = sequelize.define('Bolao', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    slug: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(160), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },

    status: {
      type: DataTypes.ENUM('draft', 'open', 'locked', 'live', 'finished'),
      allowNull: false,
      defaultValue: 'open',
    },

    prize: { type: DataTypes.STRING(80), allowNull: true },

    // Regra de pontuação (configurável por bolão).
    points_exact: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
    points_winner: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },

    // Trava única dos palpites (regra do chefe: tudo trava no apito do 1º jogo).
    // Depois desse instante a grade de palpites fica visível para todos.
    deadline_at: { type: DataTypes.DATE, allowNull: true },

    // Provider de placar ao vivo: 'espn' | 'manual' | 'apifootball'.
    provider: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'espn' },
    // Liga/competição no provider (slug do ESPN soccer, ex.: 'fifa.world').
    provider_league: { type: DataTypes.STRING(40), allowNull: true },

    created_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    tableName: 'bolao',
    underscored: true,
    timestamps: true,
  });

  Bolao.associate = (models) => {
    Bolao.hasMany(models.BolaoMatch, { as: 'matches', foreignKey: 'bolao_id' });
    Bolao.hasMany(models.BolaoParticipant, { as: 'participants', foreignKey: 'bolao_id' });
    Bolao.hasMany(models.BolaoPrediction, { as: 'predictions', foreignKey: 'bolao_id' });
  };

  return Bolao;
};

// models/sequelize/bolao/bolaoMatch.js
// Jogo de um bolão. Guarda o resultado OFICIAL (home_score/away_score, só
// preenchido no apito final) e, separadamente, o estado AO VIVO (live_*),
// atualizado pelo poller do scheduler ou por cliques manuais do operador.
export default (sequelize, DataTypes) => {
  const BolaoMatch = sequelize.define('BolaoMatch', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    bolao_id: { type: DataTypes.INTEGER, allowNull: false },

    // Ordem de exibição. NÃO usar "order" (palavra reservada no SQL).
    match_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },

    home_team: { type: DataTypes.STRING(60), allowNull: false },
    away_team: { type: DataTypes.STRING(60), allowNull: false },
    home_code: { type: DataTypes.STRING(3), allowNull: true },   // BRA, MAR, HAI, SCO
    away_code: { type: DataTypes.STRING(3), allowNull: true },
    // ISO p/ renderizar a bandeira no front (br, ma, ht, gb-sct...).
    home_country: { type: DataTypes.STRING(8), allowNull: true },
    away_country: { type: DataTypes.STRING(8), allowNull: true },

    kickoff_at: { type: DataTypes.DATE, allowNull: false },

    status: {
      type: DataTypes.ENUM('scheduled', 'live', 'halftime', 'finished', 'postponed'),
      allowNull: false,
      defaultValue: 'scheduled',
    },

    // Resultado oficial — null até o apito final. É o que o motor de pontuação usa.
    home_score: { type: DataTypes.INTEGER, allowNull: true },
    away_score: { type: DataTypes.INTEGER, allowNull: true },

    // Estado ao vivo (placar parcial + minuto), alimenta o badge e o ranking provisório.
    live_home: { type: DataTypes.INTEGER, allowNull: true },
    live_away: { type: DataTypes.INTEGER, allowNull: true },
    live_minute: { type: DataTypes.INTEGER, allowNull: true },
    live_period: { type: DataTypes.STRING(10), allowNull: true }, // 1H, HT, 2H, ET, FT

    // ID do evento no provider (ESPN event id) para casar o jogo no poll.
    provider_fixture_id: { type: DataTypes.STRING(40), allowNull: true },

    finished_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'bolao_match',
    underscored: true,
    timestamps: true,
    indexes: [{ fields: ['bolao_id'] }],
  });

  BolaoMatch.associate = (models) => {
    BolaoMatch.belongsTo(models.Bolao, { as: 'bolao', foreignKey: 'bolao_id' });
    BolaoMatch.hasMany(models.BolaoPrediction, { as: 'predictions', foreignKey: 'match_id' });
  };

  return BolaoMatch;
};

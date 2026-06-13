// models/sequelize/bolao/bolaoPrediction.js
// Palpite de um participante para um jogo. O placar é SEMPRE normalizado para a
// orientação do jogo: home_score = gols do time da casa do bolao_match. Isso
// resolve o caso real do grupo, em que quase todos escreveram "Brasil x Escócia"
// mesmo o jogo sendo "Escócia x Brasil".
export default (sequelize, DataTypes) => {
  const BolaoPrediction = sequelize.define('BolaoPrediction', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    bolao_id: { type: DataTypes.INTEGER, allowNull: false },
    match_id: { type: DataTypes.INTEGER, allowNull: false },
    participant_id: { type: DataTypes.INTEGER, allowNull: false },

    home_score: { type: DataTypes.INTEGER, allowNull: false },
    away_score: { type: DataTypes.INTEGER, allowNull: false },

    // Preenchidos quando o jogo é pontuado (apito final).
    points_awarded: { type: DataTypes.INTEGER, allowNull: true },
    is_exact: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    got_winner: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    submitted_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'bolao_prediction',
    underscored: true,
    timestamps: true,
    indexes: [
      { fields: ['match_id'] },
      { fields: ['participant_id'] },
      { unique: true, fields: ['match_id', 'participant_id'] },
    ],
  });

  BolaoPrediction.associate = (models) => {
    BolaoPrediction.belongsTo(models.Bolao, { as: 'bolao', foreignKey: 'bolao_id' });
    BolaoPrediction.belongsTo(models.BolaoMatch, { as: 'match', foreignKey: 'match_id' });
    BolaoPrediction.belongsTo(models.BolaoParticipant, { as: 'participant', foreignKey: 'participant_id' });
  };

  return BolaoPrediction;
};

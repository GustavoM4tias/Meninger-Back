// models/sequelize/bolao/bolaoParticipant.js
// Participante de um bolão. user_id liga ao usuário do Office (habilita
// notificações in-app/e-mail); convidados externos (ex.: número avulso de
// WhatsApp) ficam apenas com display_name/phone.
export default (sequelize, DataTypes) => {
  const BolaoParticipant = sequelize.define('BolaoParticipant', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    bolao_id: { type: DataTypes.INTEGER, allowNull: false },
    user_id: { type: DataTypes.INTEGER, allowNull: true },

    display_name: { type: DataTypes.STRING(80), allowNull: false },
    subtitle: { type: DataTypes.STRING(80), allowNull: true },     // cidade/cargo
    avatar_initials: { type: DataTypes.STRING(3), allowNull: true },
    phone: { type: DataTypes.STRING(20), allowNull: true },
  }, {
    tableName: 'bolao_participant',
    underscored: true,
    timestamps: true,
    indexes: [{ fields: ['bolao_id'] }],
  });

  BolaoParticipant.associate = (models) => {
    BolaoParticipant.belongsTo(models.Bolao, { as: 'bolao', foreignKey: 'bolao_id' });
    BolaoParticipant.belongsTo(models.User, { as: 'user', foreignKey: 'user_id' });
    BolaoParticipant.hasMany(models.BolaoPrediction, { as: 'predictions', foreignKey: 'participant_id' });
  };

  return BolaoParticipant;
};

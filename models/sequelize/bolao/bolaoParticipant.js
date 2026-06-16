// models/sequelize/bolao/bolaoParticipant.js
// Participante de um bolão. user_id liga ao usuário do Office (habilita
// notificações in-app/e-mail); convidados externos (ex.: número avulso de
// WhatsApp) ficam apenas com display_name/phone.
//
// Bolão público (menin.com.br/bolao): participantes da torcida se autocadastram
// sem usuário do sistema — identificados por cpf (chave anti-duplicidade, só
// dígitos, nunca exposta nas respostas públicas) e obra (texto livre que a
// pessoa informa). user_id fica null nesses casos.
export default (sequelize, DataTypes) => {
  const BolaoParticipant = sequelize.define('BolaoParticipant', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    bolao_id: { type: DataTypes.INTEGER, allowNull: false },
    user_id: { type: DataTypes.INTEGER, allowNull: true },

    display_name: { type: DataTypes.STRING(80), allowNull: false },
    subtitle: { type: DataTypes.STRING(80), allowNull: true },     // cidade/cargo (ou obra no público)
    avatar_initials: { type: DataTypes.STRING(3), allowNull: true },
    phone: { type: DataTypes.STRING(20), allowNull: true },

    // Autocadastro público — não usados pelo bolão dos gestores (ficam null).
    cpf: { type: DataTypes.STRING(11), allowNull: true },          // só dígitos; anti-replay
    obra: { type: DataTypes.STRING(120), allowNull: true },        // obra informada (texto livre)
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

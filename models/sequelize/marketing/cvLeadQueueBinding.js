// models/sequelize/marketing/cvLeadQueueBinding.js
//
// Qual fila do CV atende cada empreendimento.
//
// O CV NÃO expõe esse vínculo: ele avalia regras internas e, quando não acha
// nada compatível, represa o lead em silêncio (medido em 26/08/2026 no lead
// 12361, que tem interesse em 4 cidades). Então o vínculo passa a ser nosso.
//
// O vínculo é POR ID e é declarado por gente. Não se deduz fila por nome:
// "Fila Park Alameda" casa com "BOULEVARD PARK & RESORT" e mandaria o lead para
// a praça errada. Como a chave é o id, renomear a fila no CV não quebra nada.
//
// `origem` existe para o dia em que houver outra forma de decidir (uma regra que
// o CV venha a expor, por exemplo). Hoje só vale 'manual'.

export default (sequelize, DataTypes) => {
  const CvLeadQueueBinding = sequelize.define('CvLeadQueueBinding', {
    // idempreendimento no CV
    idempreendimento: { type: DataTypes.INTEGER, primaryKey: true },

    idfila: { type: DataTypes.INTEGER, allowNull: true },

    origem: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'manual' },

    // O que ficou registrado da escolha, para a tela mostrar o histórico.
    motivo: { type: DataTypes.STRING(300) },

    // Quem confirmou, quando foi manual.
    definido_por: { type: DataTypes.INTEGER },
  }, {
    tableName: 'cv_lead_queue_bindings',
    underscored: true,
    timestamps: true,
  });

  return CvLeadQueueBinding;
};

// models/sequelize/marketing/cvLeadQueue.js
//
// Espelho local das filas de distribuição de leads do CV
// (GET /v1/comercial/filas-distribuicao-leads).
//
// Por que espelhar em vez de sempre chamar o CV: a fila é decisão de roteamento
// que roda DENTRO do despacho de lead, e não dá para o envio de um lead depender
// de uma chamada externa de pé. O espelho é ressincronizado por scheduler e sob
// demanda, e guarda quem está em cada fila para a tela mostrar sem outra ida.
//
// `presente_no_cv = false` marca fila que sumiu do CV: não some daqui, porque um
// vínculo pode estar apontando para ela e a tela precisa dizer que quebrou.

export default (sequelize, DataTypes) => {
  const CvLeadQueue = sequelize.define('CvLeadQueue', {
    // idfila_distribuicao_leads no CV
    idfila: { type: DataTypes.INTEGER, primaryKey: true },

    nome: { type: DataTypes.STRING(180), allowNull: false },

    // Quem atende. O CV manda corretor e imobiliária juntos no mesmo array.
    corretores: { type: DataTypes.JSONB },
    gestores:   { type: DataTypes.JSONB },

    qtd_corretores: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    qtd_gestores:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    // A API não devolve os GRUPOS de atendimento nem se a fila está ativa: o
    // painel do CV mostra "Grupos: 2" onde a API não mostra ninguém. Então isto
    // é "a API não listou atendente", não "a fila está vazia", e é INFORMATIVO —
    // usar como bloqueio esconderia fila boa.
    sem_atendente_listado: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    presente_no_cv: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    synced_at:      { type: DataTypes.DATE },
  }, {
    tableName: 'cv_lead_queues',
    underscored: true,
    timestamps: true,
  });

  return CvLeadQueue;
};

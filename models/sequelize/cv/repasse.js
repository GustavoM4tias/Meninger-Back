// src/models/sequelize/cv/Repasse.js
export default (sequelize, DataTypes) => {
  const Repasse = sequelize.define('Repasse', {
    // PK do repasse na API
    idrepasse: { type: DataTypes.INTEGER, primaryKey: true }, // mapeia "ID"

    // Identificadores e textos
    idreserva: { type: DataTypes.INTEGER },
    documento: { type: DataTypes.STRING(20) },
    etapa: { type: DataTypes.STRING(100) },
    empreendimento: { type: DataTypes.STRING(255) },
    bloco: { type: DataTypes.STRING(100) },
    unidade: { type: DataTypes.STRING(255) },

    codigointerno_reserva: { type: DataTypes.STRING(50) },
    codigointerno_repasse: { type: DataTypes.STRING(50) },
    codigointerno_empreendimento: { type: DataTypes.STRING(50) },
    codigointerno_etapa: { type: DataTypes.STRING(50) },
    codigointerno_bloco: { type: DataTypes.STRING(50) },
    codigointerno_unidade: { type: DataTypes.STRING(50) },

    // --- Campos atuais (também entram no status[0]) ---
    status_reserva: { type: DataTypes.STRING(100) },
    status_repasse: { type: DataTypes.STRING(100) },
    idsituacao_repasse: { type: DataTypes.INTEGER },
    data_status_repasse: { type: DataTypes.DATE }, // armazena Date

    // Financeiro e outros (mantidos conforme API)
    data_contrato_liberado: { type: DataTypes.DATE },
    sla_prazo_repasse: { type: DataTypes.INTEGER },

    valor_financiado: { type: DataTypes.DECIMAL(14,2) },
    valor_previsto: { type: DataTypes.DECIMAL(14,2) },
    valor_divida: { type: DataTypes.DECIMAL(14,2) },
    valor_subsidio: { type: DataTypes.DECIMAL(14,2) },
    valor_fgts: { type: DataTypes.DECIMAL(14,2) },
    valor_registro: { type: DataTypes.DECIMAL(14,2) },

    data_status_financiamento: { type: DataTypes.DATE },
    registro_pago: { type: DataTypes.STRING(1) },
    parcela_conclusao: { type: DataTypes.DECIMAL(14,2) },
    parcela_baixada: { type: DataTypes.STRING(1) },
    saldo_devedor: { type: DataTypes.DECIMAL(14,2) },

    contrato_interno: { type: DataTypes.STRING(100) },
    valor_contrato: { type: DataTypes.DECIMAL(14,2) },
    numero_contrato: { type: DataTypes.STRING(100) },
    situacao_contrato: { type: DataTypes.STRING(2) },
    contrato_quitado: { type: DataTypes.STRING(1) },
    contrato_liquidado: { type: DataTypes.STRING(1) },
    data_contrato_contab: { type: DataTypes.DATE },
    proxima_acao: { type: DataTypes.STRING(255) },
    liberar_assinatura: { type: DataTypes.STRING(1) },
    num_matricula: { type: DataTypes.STRING(100) },
    data_assinatura: { type: DataTypes.DATE },
    recebendo_financiamento: { type: DataTypes.STRING(1) },
    itbi_pago: { type: DataTypes.STRING(1) },
    laudemio_pago: { type: DataTypes.STRING(1) },
    data_unidade_liberada: { type: DataTypes.DATE },
    data_laudo_liberado: { type: DataTypes.DATE },
    data_recurso_liberado: { type: DataTypes.DATE },
    porcentagem_medicao_obra: { type: DataTypes.DECIMAL(5,2) },

    // --- Histórico (array de snapshots; status[0] é o atual) ---
    // cada item: { status_reserva, status_repasse, idsituacao_repasse, data_status_repasse, captured_at }
    status: { type: DataTypes.JSONB, defaultValue: [] },

    // Metadados úteis
    first_seen_at: { type: DataTypes.DATE },
    last_seen_at: { type: DataTypes.DATE },
  }, {
    tableName: 'repasses',
    underscored: true,
    timestamps: true,
    indexes: [
      { fields: ['documento'] },
      { fields: ['empreendimento'] },
      { fields: ['idsituacao_repasse'] },
      { fields: ['data_status_repasse'] },
    ]
  });

  return Repasse;
};

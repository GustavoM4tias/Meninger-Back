// src/models/sequelize/cv/Repasse.js
export default (sequelize, DataTypes) => {
  const Repasse = sequelize.define('Repasse', {
    idrepasse: { type: DataTypes.INTEGER, primaryKey: true },

    idreserva: { type: DataTypes.INTEGER },
    documento: { type: DataTypes.STRING },  // sem length
    etapa: { type: DataTypes.STRING },
    empreendimento: { type: DataTypes.STRING },
    bloco: { type: DataTypes.STRING },
    unidade: { type: DataTypes.STRING },

    codigointerno_reserva: { type: DataTypes.STRING },
    codigointerno_repasse: { type: DataTypes.STRING },
    codigointerno_empreendimento: { type: DataTypes.STRING },
    codigointerno_etapa: { type: DataTypes.STRING },
    codigointerno_bloco: { type: DataTypes.STRING },
    codigointerno_unidade: { type: DataTypes.STRING },

    // CRÍTICOS (usados por MV)
    status_reserva: { type: DataTypes.STRING },
    status_repasse: { type: DataTypes.STRING }, // <– sem length
    idsituacao_repasse: { type: DataTypes.INTEGER },
    data_status_repasse: { type: DataTypes.DATE },

    // Financeiros/operacionais
    data_contrato_liberado: { type: DataTypes.DATE },
    sla_prazo_repasse: { type: DataTypes.INTEGER },

    valor_financiado: { type: DataTypes.DECIMAL(14, 2) },
    valor_previsto: { type: DataTypes.DECIMAL(14, 2) },
    valor_divida: { type: DataTypes.DECIMAL(14, 2) },
    valor_subsidio: { type: DataTypes.DECIMAL(14, 2) },
    valor_fgts: { type: DataTypes.DECIMAL(14, 2) },
    valor_registro: { type: DataTypes.DECIMAL(14, 2) },

    data_status_financiamento: { type: DataTypes.DATE },
    registro_pago: { type: DataTypes.STRING(1) },
    parcela_conclusao: { type: DataTypes.DECIMAL(14, 2) },
    parcela_baixada: { type: DataTypes.STRING(1) },
    saldo_devedor: { type: DataTypes.DECIMAL(14, 2) },

    contrato_interno: { type: DataTypes.STRING },
    valor_contrato: { type: DataTypes.DECIMAL(14, 2) },
    numero_contrato: { type: DataTypes.STRING },
    situacao_contrato: { type: DataTypes.STRING }, // sem length
    contrato_quitado: { type: DataTypes.STRING(1) },
    contrato_liquidado: { type: DataTypes.STRING(1) },
    data_contrato_contab: { type: DataTypes.DATE },
    proxima_acao: { type: DataTypes.STRING },
    liberar_assinatura: { type: DataTypes.STRING(1) },
    num_matricula: { type: DataTypes.STRING },
    data_assinatura: { type: DataTypes.DATE },
    recebendo_financiamento: { type: DataTypes.STRING(1) },
    itbi_pago: { type: DataTypes.STRING(1) },
    laudemio_pago: { type: DataTypes.STRING(1) },
    data_unidade_liberada: { type: DataTypes.DATE },
    data_laudo_liberado: { type: DataTypes.DATE },
    data_recurso_liberado: { type: DataTypes.DATE },
    porcentagem_medicao_obra: { type: DataTypes.DECIMAL(5, 2) },

    status: { type: DataTypes.JSONB, defaultValue: [] },
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

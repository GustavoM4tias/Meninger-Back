// models/sequelize/marketing/inboundLeadEvent.js
//
// Trilha de auditoria append-only de um inbound_lead: uma linha por passo
// (recebido, validado, roteado, tentativa de envio, entregue, recusado...).
// É o que a tela de detalhe mostra como timeline — e onde se descobre
// exatamente onde um lead travou.

export default (sequelize, DataTypes) => {
  const InboundLeadEvent = sequelize.define('InboundLeadEvent', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    inbound_lead_id: { type: DataTypes.UUID, allowNull: false },

    // received | validated | spam_flagged | routed | held | reentry_detected
    //  | dispatch_attempt | dry_run | cv_delivered | cv_rejected
    //  | dispatch_failed | dead_letter | recovered_stuck | manual_redispatch
    event_type:  { type: DataTypes.STRING(40), allowNull: false },

    status_from: { type: DataTypes.STRING(20) },
    status_to:   { type: DataTypes.STRING(20) },
    message:     { type: DataTypes.TEXT },
    detail:      { type: DataTypes.JSONB },

    // 'system' | 'scheduler' | 'user:<id>'
    actor:       { type: DataTypes.STRING(60), allowNull: false, defaultValue: 'system' },
  }, {
    tableName: 'inbound_lead_events',
    underscored: true,
    timestamps: true,
  });

  return InboundLeadEvent;
};

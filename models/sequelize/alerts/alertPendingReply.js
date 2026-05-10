// models/sequelize/alerts/alertPendingReply.js
//
// Controla o tracking da resposta do WhatsApp pra um alerta específico.
//
// Fluxo:
//   1. Sistema envia template de alerta → state='awaiting_reply', salva wamid em meta_message_id
//   2. User RESPONDE essa mensagem específica (reply do WhatsApp) com "SIM" / "NÃO"
//      O webhook traz `context.id = wamid`, então amarramos sem ambiguidade.
//   3. SIM → state='sent', sistema manda relatório em texto livre (grátis na janela 24h)
//      NÃO → state='cancelled'
//      Outra coisa em reply → manda nudge pedindo SIM ou NÃO.
//      Mensagem solta sem reply (context vazio) → IGNORA totalmente. Usuário pode
//      conversar normalmente no número sem disparar relatórios.
//
// expires_at: 23h após o envio do template inicial (margem da janela 24h Meta).

import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
  class AlertPendingReply extends Model {
    static associate(models) {
      AlertPendingReply.belongsTo(models.AlertRule,       { foreignKey: 'alert_rule_id', as: 'rule' });
      AlertPendingReply.belongsTo(models.AlertTriggerLog, { foreignKey: 'log_id',        as: 'log' });
      AlertPendingReply.belongsTo(models.User,            { foreignKey: 'user_id',       as: 'user' });
    }
  }

  AlertPendingReply.init({
    alert_rule_id: { type: DataTypes.INTEGER, allowNull: false },
    log_id:        { type: DataTypes.INTEGER, allowNull: true  },
    user_id:       { type: DataTypes.INTEGER, allowNull: false },

    phone:         { type: DataTypes.STRING(20),  allowNull: false }, // E.164 do user
    rule_name:     { type: DataTypes.STRING(255), allowNull: false }, // snapshot pra mensagem de confirmação

    // wamid da mensagem template de alerta enviada — usado pra amarrar a resposta
    // do user (que vem com context.id = wamid quando ele usa "responder" no WhatsApp).
    meta_message_id: { type: DataTypes.STRING(120), allowNull: true },

    state: {
      type: DataTypes.ENUM('awaiting_reply', 'sent', 'expired', 'cancelled'),
      allowNull: false,
      defaultValue: 'awaiting_reply',
    },

    // Relatório completo já renderizado, pronto pra mandar quando user confirmar
    report_payload: { type: DataTypes.TEXT, allowNull: false },

    expires_at:     { type: DataTypes.DATE, allowNull: false },
    confirmed_at:   { type: DataTypes.DATE, allowNull: true  },
    report_sent_at: { type: DataTypes.DATE, allowNull: true  },

    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    sequelize,
    modelName: 'AlertPendingReply',
    tableName: 'alert_pending_replies',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['meta_message_id'],  name: 'alert_pending_wamid_idx' },
      { fields: ['phone', 'state'],   name: 'alert_pending_phone_state_idx' },
      { fields: ['expires_at'],       name: 'alert_pending_expires_idx' },
    ],
  });

  return AlertPendingReply;
};

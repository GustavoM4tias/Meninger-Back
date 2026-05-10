// models/sequelize/alerts/alertTriggerLog.js
//
// Histórico de cada disparo de uma regra de alerta.
// Útil pra: debugar, mostrar "última vez" no painel, calcular custo.

import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
  class AlertTriggerLog extends Model {
    static associate(models) {
      AlertTriggerLog.belongsTo(models.AlertRule,        { foreignKey: 'alert_rule_id', as: 'rule' });
      AlertTriggerLog.belongsTo(models.Notification,     { foreignKey: 'notification_id', as: 'notification' });
      AlertTriggerLog.belongsTo(models.WhatsappMessage,  { foreignKey: 'whatsapp_message_id', as: 'whatsappMessage' });
    }
  }

  AlertTriggerLog.init({
    alert_rule_id: { type: DataTypes.INTEGER, allowNull: false },
    fired_at:      { type: DataTypes.DATE,    allowNull: false, defaultValue: DataTypes.NOW },

    // Resultado bruto da execução da tool — pra reproduzir/debug
    tool_result_summary: { type: DataTypes.TEXT, allowNull: true },

    status: {
      type: DataTypes.ENUM(
        'success', 'partial', 'failed',
        'suppressed_cooldown',
        'suppressed_disabled',
        'suppressed_daily_limit',
      ),
      allowNull: false,
      defaultValue: 'success',
    },

    notification_id:     { type: DataTypes.INTEGER, allowNull: true }, // FK pra notification in-app criada
    whatsapp_message_id: { type: DataTypes.INTEGER, allowNull: true }, // FK pra whatsapp_messages

    error_message: { type: DataTypes.TEXT, allowNull: true },

    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    sequelize,
    modelName: 'AlertTriggerLog',
    tableName: 'alert_trigger_logs',
    underscored: true,
    timestamps: false,
    indexes: [
      { fields: ['alert_rule_id', 'fired_at'], name: 'alert_logs_rule_fired_idx' },
      { fields: ['status'],                    name: 'alert_logs_status_idx' },
    ],
  });

  return AlertTriggerLog;
};

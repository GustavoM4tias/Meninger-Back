// models/sequelize/whatsapp/whatsappMessage.js
//
// Log completo de mensagens enviadas e recebidas via WhatsApp.
// Saída (out): notificações disparadas pelo NotificationService.
// Entrada (in): mensagens recebidas no webhook (preparado para futuro atendimento).

import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
  class WhatsappMessage extends Model {
    static associate(models) {
      WhatsappMessage.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
      WhatsappMessage.belongsTo(models.Notification, { foreignKey: 'notification_id', as: 'notification' });
    }
  }

  WhatsappMessage.init({
    direction: {
      type: DataTypes.ENUM('out', 'in'),
      allowNull: false,
      defaultValue: 'out',
    },

    // ─── Identificação ────────────────────────────────────────────────────
    notification_id: { type: DataTypes.INTEGER,  allowNull: true }, // FK opcional pra Notification
    user_id:         { type: DataTypes.INTEGER,  allowNull: true }, // destinatário interno se houver
    to_phone:        { type: DataTypes.STRING(20), allowNull: false }, // E.164
    from_phone:      { type: DataTypes.STRING(20), allowNull: true  }, // só preenche em direction='in'

    // ─── Conteúdo enviado/recebido ────────────────────────────────────────
    type: { // tipo de payload na Cloud API
      type: DataTypes.ENUM('template', 'text', 'image', 'document', 'audio', 'video', 'interactive', 'button', 'unknown'),
      allowNull: false,
      defaultValue: 'template',
    },
    template_name:     { type: DataTypes.STRING(120), allowNull: true },
    template_language: { type: DataTypes.STRING(10),  allowNull: true, defaultValue: 'pt_BR' },
    variables:         { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    body:              { type: DataTypes.TEXT, allowNull: true }, // texto livre (text/in)
    media_url:         { type: DataTypes.TEXT, allowNull: true },
    raw_payload:       { type: DataTypes.JSON, allowNull: true }, // payload completo (debug)

    // ─── Estado ───────────────────────────────────────────────────────────
    status: {
      type: DataTypes.ENUM('queued', 'sent', 'delivered', 'read', 'failed', 'received', 'dry_run'),
      allowNull: false,
      defaultValue: 'queued',
    },
    meta_message_id: { type: DataTypes.STRING(100), allowNull: true }, // wamid retornado pela Meta
    error_code:      { type: DataTypes.STRING(50),  allowNull: true },
    error_message:   { type: DataTypes.TEXT,        allowNull: true },

    // categoria de cobrança (Meta retorna nas confirmações)
    cost_category: { type: DataTypes.STRING(20), allowNull: true },

    // ─── Timestamps ───────────────────────────────────────────────────────
    sent_at:      { type: DataTypes.DATE, allowNull: true },
    delivered_at: { type: DataTypes.DATE, allowNull: true },
    read_at:      { type: DataTypes.DATE, allowNull: true },
    failed_at:    { type: DataTypes.DATE, allowNull: true },

    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    sequelize,
    modelName: 'WhatsappMessage',
    tableName: 'whatsapp_messages',
    underscored: true,
    timestamps: false,
    indexes: [
      { fields: ['user_id', 'created_at'], name: 'whatsapp_messages_user_created_idx' },
      { fields: ['status'], name: 'whatsapp_messages_status_idx' },
      { fields: ['meta_message_id'], name: 'whatsapp_messages_meta_id_idx' },
      { fields: ['direction', 'created_at'], name: 'whatsapp_messages_dir_created_idx' },
    ],
  });

  return WhatsappMessage;
};

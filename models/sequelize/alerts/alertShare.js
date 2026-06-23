// models/sequelize/alerts/alertShare.js
//
// Convite de compartilhamento de um alerta para outro usuário.
//
// Fluxo:
//   1. Dono (ou admin) compartilha uma alert_rule com outro user → cria um share
//      com state='pending'. O destinatário recebe na tela de Alertas + notificação
//      (in-app / e-mail / WhatsApp com SIM/NÃO).
//   2. Destinatário ACEITA → o sistema CLONA a regra pra ele (cópia independente,
//      owner = destinatário), guarda cloned_rule_id e marca 'accepted'.
//      RECUSA → marca 'declined'. Sem resposta até expires_at → 'expired'.
//
// meta_message_id guarda o wamid do template de convite enviado no WhatsApp, pra
// amarrar a resposta SIM/NÃO (context.id do reply) — mesma técnica do
// alert_pending_replies.
//
// IMPORTANTE (memória feedback_sequelize_alter): índices ficam FORA do model e
// são criados em lib/ensureAlertSharesSchema.js — sync({alter:true}) tem bug de
// criar índice antes da coluna. A tabela em si é criada pelo sync({alter:false}).

import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
  class AlertShare extends Model {
    static associate(models) {
      AlertShare.belongsTo(models.AlertRule, { foreignKey: 'alert_rule_id',  as: 'rule' });
      AlertShare.belongsTo(models.AlertRule, { foreignKey: 'cloned_rule_id', as: 'clonedRule' });
      AlertShare.belongsTo(models.User,      { foreignKey: 'from_user_id',   as: 'fromUser' });
      AlertShare.belongsTo(models.User,      { foreignKey: 'to_user_id',     as: 'toUser' });
    }
  }

  AlertShare.init({
    alert_rule_id: { type: DataTypes.INTEGER, allowNull: false }, // regra original compartilhada
    from_user_id:  { type: DataTypes.INTEGER, allowNull: false }, // quem compartilhou
    to_user_id:    { type: DataTypes.INTEGER, allowNull: false }, // destinatário

    status: {
      type: DataTypes.ENUM('pending', 'accepted', 'declined', 'expired'),
      allowNull: false,
      defaultValue: 'pending',
    },

    note: { type: DataTypes.TEXT, allowNull: true }, // mensagem opcional do remetente

    // Canais por onde o convite foi disparado — só pra exibição/auditoria.
    channels: { type: DataTypes.JSON, allowNull: false, defaultValue: { inapp: true, email: true, whatsapp: false } },

    // wamid do template de convite (WhatsApp) — usado pra casar a resposta SIM/NÃO.
    meta_message_id: { type: DataTypes.STRING(120), allowNull: true },

    // Regra clonada criada no aceite (provenance). Null enquanto pending/declined.
    cloned_rule_id: { type: DataTypes.INTEGER, allowNull: true },

    expires_at:   { type: DataTypes.DATE, allowNull: false },
    responded_at: { type: DataTypes.DATE, allowNull: true },

    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    sequelize,
    modelName: 'AlertShare',
    tableName: 'alert_shares',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    // Índices criados em lib/ensureAlertSharesSchema.js (ver nota no topo).
  });

  return AlertShare;
};

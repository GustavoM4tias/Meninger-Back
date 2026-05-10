// models/sequelize/alerts/alertRule.js
//
// Regra de alerta criada pela IA Eme. Cada regra é uma "receita" reutilizável
// que sabe:
//   - Quando rodar (cron)
//   - O que buscar (tool_call: { tool, args }) — usa as próprias tools da Eme
//   - Como apresentar (title_template, preview_template renderizados via Handlebars)
//   - Pra quem mandar (owner_user_id) e por quais canais (channels)
//
// IMPORTANTE: criação é exclusiva da IA Eme. UI só faz gestão (toggle, editar
// schedule/canais, deletar). Garante consistência de formato e proteção contra
// regras malformadas.

import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
  class AlertRule extends Model {
    static associate(models) {
      AlertRule.belongsTo(models.User, { foreignKey: 'owner_user_id', as: 'owner' });
      AlertRule.belongsTo(models.User, { foreignKey: 'created_by_user_id', as: 'createdBy' });
      AlertRule.hasMany(models.AlertTriggerLog, { foreignKey: 'alert_rule_id', as: 'logs' });
    }
  }

  AlertRule.init({
    name:        { type: DataTypes.STRING(180), allowNull: false },
    description: { type: DataTypes.TEXT,        allowNull: true  },

    // Quem recebe vs. quem criou (admin pode criar pra outro user)
    owner_user_id:      { type: DataTypes.INTEGER, allowNull: false },
    created_by_user_id: { type: DataTypes.INTEGER, allowNull: false },
    created_via_chat_session_id: { type: DataTypes.UUID, allowNull: true }, // sessão Eme onde foi criada

    // Disparo (por enquanto só schedule — event/condition em fase futura)
    trigger_type: {
      type: DataTypes.ENUM('schedule', 'event', 'condition'),
      allowNull: false,
      defaultValue: 'schedule',
    },
    cron:     { type: DataTypes.STRING(50), allowNull: true }, // '0 8 * * 1' — usado se trigger_type='schedule'
    timezone: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'America/Sao_Paulo' },

    // Receita do relatório — snapshot da chamada da tool da Eme.
    // Ex: { tool: 'query_leads', args: { data_inicio: { dynamic: 'start_of_week' }, group_by: 'midia' } }
    tool_call: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },

    // Templates Handlebars renderizados em cada disparo
    title_template:   { type: DataTypes.STRING(255), allowNull: false }, // ex: "Resumo de Leads {{enterprise}}"
    preview_template: { type: DataTypes.TEXT,        allowNull: true  }, // 1 linha pra notificação curta

    channels: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: { inapp: true, email: false, whatsapp: true },
    },

    enabled:          { type: DataTypes.BOOLEAN,  allowNull: false, defaultValue: true },
    cooldown_minutes: { type: DataTypes.INTEGER,  allowNull: false, defaultValue: 0 },

    last_triggered_at: { type: DataTypes.DATE,    allowNull: true },
    trigger_count:     { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    sequelize,
    modelName: 'AlertRule',
    tableName: 'alert_rules',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['owner_user_id', 'enabled'], name: 'alert_rules_owner_enabled_idx' },
      { fields: ['trigger_type'],              name: 'alert_rules_trigger_type_idx' },
    ],
  });

  return AlertRule;
};

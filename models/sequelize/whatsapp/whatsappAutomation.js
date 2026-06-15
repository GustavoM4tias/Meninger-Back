// models/sequelize/whatsapp/whatsappAutomation.js
//
// Registro DB-driven das automações de WhatsApp: qual TEMPLATE dispara em qual
// GATILHO, com qual mapeamento de variáveis, botões e ações de resposta, para
// quais destinatários. Substitui os hardcodes (ALERT_TEMPLATES no AlertEngine,
// specs `whatsapp` de notificationTypes, template do boleto) por config editável
// pelo portal — sem mexer em código.
//
// PRINCÍPIO (igual ao Cérebro da Eme): semeado com o comportamento atual; o
// runtime lê daqui com fallback ao hardcode → zero regressão no dia 1.

export default (sequelize, DataTypes) => {
  const WhatsappAutomation = sequelize.define('WhatsappAutomation', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    // Slug estável (ex: 'alert_generic', 'boleto_ready', 'event_reminder').
    key: { type: DataTypes.STRING(120), allowNull: false, unique: true },

    name: { type: DataTypes.STRING(200), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },

    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

    // schedule (cron) | event (disparado por um evento do sistema) | manual
    triggerType: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'event' },

    // schedule → { cron, timezone }; event → { event: 'alert.fired' | 'boleto.generated' | ... }
    triggerConfig: { type: DataTypes.JSONB, allowNull: true },

    // Template da Meta usado (nome + idioma). O catálogo vem de whatsapp_templates.
    templateName: { type: DataTypes.STRING(120), allowNull: true },
    templateLanguage: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pt_BR' },

    // Mapa {{n}} → caminho na carga do gatilho. Ex: { "1": "owner.username", "2": "title" }.
    variableMapping: { type: DataTypes.JSONB, allowNull: true },

    // Botões quick-reply do template. Ex: [{ text:'SIM', action:'yes' }, { text:'NÃO', action:'no' }].
    buttons: { type: DataTypes.JSONB, allowNull: true },

    // Ações de resposta por botão/palavra. Ex:
    //   { yes: { type:'send_report' }, no: { type:'cancel' } }
    // type: send_report (manda o relatório da tool) | send_text | cancel | none.
    replyActions: { type: DataTypes.JSONB, allowNull: true },

    // Destinatários. { mode:'owner' } (dono da regra) | { users:[], positions:[], phones:[] }.
    recipients: { type: DataTypes.JSONB, allowNull: true },

    // Categoria Meta (UTILITY | MARKETING | AUTHENTICATION).
    category: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'UTILITY' },

    // Automação de sistema (alerta/boleto/lembrete) — editável, não deletável.
    isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    createdBy: { type: DataTypes.STRING(120), allowNull: true },
    updatedBy: { type: DataTypes.STRING(120), allowNull: true },
  }, {
    tableName: 'whatsapp_automations',
    underscored: true,
    timestamps: true,
    indexes: [
      { unique: true, fields: ['key'] },
      { fields: ['enabled'] },
      { fields: ['trigger_type'] },
    ],
  });

  return WhatsappAutomation;
};

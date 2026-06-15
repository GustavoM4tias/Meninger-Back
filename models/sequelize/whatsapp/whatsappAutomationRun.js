// models/sequelize/whatsapp/whatsappAutomationRun.js
//
// Log de execução das automações de WhatsApp — o que disparou, com que carga,
// status do envio e custo. Base de auditoria e de métricas no portal.

export default (sequelize, DataTypes) => {
  const WhatsappAutomationRun = sequelize.define('WhatsappAutomationRun', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    automationId: { type: DataTypes.UUID, allowNull: true },
    automationKey: { type: DataTypes.STRING(120), allowNull: true }, // snapshot

    // Carga que originou o disparo (evento/contexto) — para reprocessar/auditar.
    triggerPayload: { type: DataTypes.JSONB, allowNull: true },

    templateName: { type: DataTypes.STRING(120), allowNull: true },

    // sent | failed | dry_run | skipped
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'sent' },

    wamid: { type: DataTypes.STRING(120), allowNull: true },
    error: { type: DataTypes.TEXT, allowNull: true },
    costCategory: { type: DataTypes.STRING(30), allowNull: true },
  }, {
    tableName: 'whatsapp_automation_runs',
    underscored: true,
    timestamps: true,
    indexes: [
      { fields: ['automation_id'] },
      { fields: ['status'] },
      { fields: ['created_at'] },
    ],
  });

  return WhatsappAutomationRun;
};

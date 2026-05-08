// models/sequelize/whatsapp/whatsappTemplate.js
//
// Cache local dos templates aprovados na Meta. Sincroniza periodicamente via API.
// Usado para validar antes de enviar e para alimentar UI de gestão.

import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
  class WhatsappTemplate extends Model {}

  WhatsappTemplate.init({
    // chave Meta
    name:     { type: DataTypes.STRING(120), allowNull: false }, // ex: "event_reminder_v1"
    language: { type: DataTypes.STRING(10),  allowNull: false, defaultValue: 'pt_BR' },
    meta_id:  { type: DataTypes.STRING(80),  allowNull: true  }, // id no lado da Meta

    category: {
      type: DataTypes.ENUM('UTILITY', 'MARKETING', 'AUTHENTICATION'),
      allowNull: false,
      defaultValue: 'UTILITY',
    },
    status: {
      type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED', 'DISABLED', 'PAUSED'),
      allowNull: false,
      defaultValue: 'PENDING',
    },

    // estrutura do template (cache para preview/validação)
    components: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    body_text:  { type: DataTypes.TEXT, allowNull: true }, // só o body, p/ preview rápido
    variables_count: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },

    // motivo de rejeição quando houver
    quality_score: { type: DataTypes.STRING(20), allowNull: true },
    rejected_reason: { type: DataTypes.TEXT, allowNull: true },

    synced_at:  { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    sequelize,
    modelName: 'WhatsappTemplate',
    tableName: 'whatsapp_templates',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { unique: true, fields: ['name', 'language'], name: 'whatsapp_templates_name_lang_uniq' },
      { fields: ['status'] },
    ],
  });

  return WhatsappTemplate;
};

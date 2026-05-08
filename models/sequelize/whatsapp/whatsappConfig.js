// models/sequelize/whatsapp/whatsappConfig.js
//
// Configuração singleton da conta WhatsApp Business (Cloud API).
// Esperamos exatamente uma row (id = 1). access_token é guardado criptografado.

import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
  class WhatsappConfig extends Model {}

  WhatsappConfig.init({
    // identificação Meta
    business_id:     { type: DataTypes.STRING(100), allowNull: true },  // Meta Business ID
    waba_id:         { type: DataTypes.STRING(100), allowNull: true },  // WhatsApp Business Account ID
    phone_number_id: { type: DataTypes.STRING(100), allowNull: true },  // ID do número (não o telefone)
    display_phone:   { type: DataTypes.STRING(40),  allowNull: true },  // ex: "+55 11 99999-9999"
    display_name:    { type: DataTypes.STRING(100), allowNull: true },  // nome de exibição aprovado

    // segredos (criptografados via utils/encryption.js)
    access_token_enc:        { type: DataTypes.TEXT, allowNull: true },
    app_secret_enc:          { type: DataTypes.TEXT, allowNull: true },
    webhook_verify_token_enc:{ type: DataTypes.TEXT, allowNull: true },

    // versão da Graph API a usar
    api_version: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'v21.0' },

    // flags operacionais
    active:  { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, // só envia se true
    dry_run: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true  }, // se true, loga em vez de enviar

    // saúde
    last_health_at:    { type: DataTypes.DATE, allowNull: true },
    last_health_ok:    { type: DataTypes.BOOLEAN, allowNull: true },
    last_health_error: { type: DataTypes.TEXT,    allowNull: true },

    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    sequelize,
    modelName: 'WhatsappConfig',
    tableName: 'whatsapp_configs',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return WhatsappConfig;
};

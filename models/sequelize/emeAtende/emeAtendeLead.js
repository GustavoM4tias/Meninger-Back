// models/sequelize/emeAtende/emeAtendeLead.js
//
// Lead recebido pela Eme Atende (via API, tap do marketing ou contato frio inbound).
// Futuro: vincular ao lead do CV (cv_lead_id) pra mover etapas do funil.

import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
    class EmeAtendeLead extends Model {}

    EmeAtendeLead.init({
        name: { type: DataTypes.STRING(180), allowNull: true },
        phone: { type: DataTypes.STRING(20), allowNull: false }, // normalizado 55DDD...
        email: { type: DataTypes.STRING(180), allowNull: true },
        source: { type: DataTypes.STRING(60), allowNull: true },   // meta|site|cv|manual|whatsapp_inbound...
        campaign: { type: DataTypes.STRING(180), allowNull: true },
        empreendimento: { type: DataTypes.STRING(180), allowNull: true },
        external_id: { type: DataTypes.STRING(80), allowNull: true }, // id no sistema de origem
        // futuro: reconciliação com o CRM pra Eme Atende mover etapa do lead
        cv_lead_id: { type: DataTypes.STRING(40), allowNull: true },
        payload: { type: DataTypes.JSONB, allowNull: true, defaultValue: {} },
        // received|opened|engaged|qualified|handoff|closed|opted_out
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'received' },
        qualified_summary: { type: DataTypes.TEXT, allowNull: true },
        flow_id: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        sequelize,
        modelName: 'EmeAtendeLead',
        tableName: 'eme_atende_leads',
        underscored: true,
        timestamps: true,
        indexes: [{ fields: ['phone'] }, { fields: ['status'] }],
    });

    return EmeAtendeLead;
};

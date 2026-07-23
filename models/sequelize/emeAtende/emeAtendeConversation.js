// models/sequelize/emeAtende/emeAtendeConversation.js
//
// Conversa da Eme Atende com um lead. state controla o fluxo:
// bot (IA responde) | closed (encerrada). Sem atendimento humano.

import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
    class EmeAtendeConversation extends Model {}

    EmeAtendeConversation.init({
        phone: { type: DataTypes.STRING(20), allowNull: false },
        state: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'bot' },
        last_inbound_at: { type: DataTypes.DATE, allowNull: true },  // janela de 24h
        last_outbound_at: { type: DataTypes.DATE, allowNull: true },
        ai_messages_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        lead_id: { type: DataTypes.INTEGER, allowNull: true },
        flow_id: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        sequelize,
        modelName: 'EmeAtendeConversation',
        tableName: 'eme_atende_conversations',
        underscored: true,
        timestamps: true,
        indexes: [{ fields: ['phone'] }, { fields: ['state'] }],
    });

    return EmeAtendeConversation;
};

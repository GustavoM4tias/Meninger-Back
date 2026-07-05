// models/sequelize/emeAtende/emeAtendeMessage.js
//
// Transcript da Eme Atende (in + out, incluindo dry_run). Separado de
// whatsapp_messages de propósito: whatsapp_messages é o log do canal de
// NOTIFICAÇÃO do Office; aqui é o transcript de ATENDIMENTO do produto Eme Atende.
// Statuses da Meta são roteados pro dono do wamid (ver EmeAtendeWebhookRouter).

import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
    class EmeAtendeMessage extends Model {}

    EmeAtendeMessage.init({
        direction: { type: DataTypes.STRING(3), allowNull: false }, // in|out
        type: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'text' },
        body: { type: DataTypes.TEXT, allowNull: true },
        wamid: { type: DataTypes.STRING(120), allowNull: true },
        // received|sent|delivered|read|failed|dry_run
        status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'received' },
        error_message: { type: DataTypes.TEXT, allowNull: true },
        cost_category: { type: DataTypes.STRING(20), allowNull: true },
        raw: { type: DataTypes.JSONB, allowNull: true },
        conversation_id: { type: DataTypes.INTEGER, allowNull: false },
    }, {
        sequelize,
        modelName: 'EmeAtendeMessage',
        tableName: 'eme_atende_messages',
        underscored: true,
        timestamps: true,
        indexes: [{ fields: ['conversation_id'] }, { fields: ['wamid'] }],
    });

    return EmeAtendeMessage;
};

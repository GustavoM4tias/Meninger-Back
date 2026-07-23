// models/sequelize/emeAtende/emeAtendeEvent.js
//
// Trilha de auditoria por lead (mesma filosofia de inbound_lead_events):
// lead_received, flow_assigned, opener_sent, trigger_fired, qualified, ...

import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
    class EmeAtendeEvent extends Model {}

    EmeAtendeEvent.init({
        type: { type: DataTypes.STRING(60), allowNull: false },
        detail: { type: DataTypes.JSONB, allowNull: true, defaultValue: {} },
        lead_id: { type: DataTypes.INTEGER, allowNull: true },
        conversation_id: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        sequelize,
        modelName: 'EmeAtendeEvent',
        tableName: 'eme_atende_events',
        underscored: true,
        timestamps: true,
        indexes: [{ fields: ['lead_id'] }],
    });

    return EmeAtendeEvent;
};

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

        // Última mensagem DO LEAD que já entrou numa rodada de IA. O corte do
        // "o que ainda não respondi" é por aqui, não pela última linha da
        // conversa: mensagem que chega ENQUANTO a rodada anterior roda ficava
        // órfã (a última linha virava a resposta do bot) e era descartada.
        last_answered_message_id: { type: DataTypes.INTEGER, allowNull: true },

        // ── Debounce persistente ─────────────────────────────────────────────
        // ai_due_at = quando a rodada de IA deve rodar (gravado no inbound).
        // O timer em memória é só o caminho rápido; quem garante o disparo é o
        // sweeper, e quem impede DUAS réplicas de responderem o mesmo lead é o
        // UPDATE condicional que zera ai_due_at (mesmo lock do AlertEngine).
        ai_due_at:     { type: DataTypes.DATE, allowNull: true },
        ai_claimed_at: { type: DataTypes.DATE, allowNull: true },
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

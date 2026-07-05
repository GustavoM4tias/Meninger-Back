// models/sequelize/emeAtende/emeAtendeSetting.js
//
// Config singleton (id=1) da Eme Atende - atendente IA de leads via WhatsApp.
// O canal (número/token) é o do Office (whatsapp_configs); aqui ficam apenas
// as flags do PRODUTO Eme Atende. active=false por default: com número compartilhado,
// ligar a Eme Atende muda o destino das mensagens de externos (deixam de cair na
// auto-resposta do Office e passam pro atendimento IA).

import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
    class EmeAtendeSetting extends Model {}

    EmeAtendeSetting.init({
        // liga/desliga o roteamento de externos pra Eme Atende no webhook
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        // true = respostas/openers viram log (eme_atende_messages status dry_run), zero envio
        dry_run: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        // segundos juntando mensagens picadas antes da IA responder
        debounce_seconds: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 8 },
        // teto de respostas de IA por conversa (anti-loop / custo)
        max_ai_messages: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30 },
    }, {
        sequelize,
        modelName: 'EmeAtendeSetting',
        tableName: 'eme_atende_settings',
        underscored: true,
        timestamps: true,
    });

    return EmeAtendeSetting;
};

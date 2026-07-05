// models/sequelize/emeAtende/emeAtendeFlow.js
//
// Fluxo de atendimento da Eme Atende - tudo editável sem deploy (filosofia Brain
// Studio): persona, contexto de negócio, gatilhos e template de abertura.
// STRING em vez de ENUM (padrão da casa pro sync alter).

import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
    class EmeAtendeFlow extends Model {}

    EmeAtendeFlow.init({
        name: { type: DataTypes.STRING(120), allowNull: false },
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        is_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        // persona/comportamento da IA
        system_prompt: { type: DataTypes.TEXT, allowNull: true },
        // contexto de negócio: empreendimentos, condições, plantão (única fonte
        // de verdade sobre produto - a IA é proibida de afirmar fora daqui)
        business_context: { type: DataTypes.TEXT, allowNull: true },
        // template Meta APROVADO que abre a conversa (validado em whatsapp_templates)
        opener_template: { type: DataTypes.STRING(120), allowNull: true },
        opener_language: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pt_BR' },
        // campos do lead que preenchem {{1}}, {{2}}... na ordem: ["name","empreendimento"]
        opener_variables: { type: DataTypes.JSONB, allowNull: true, defaultValue: [] },
        // gatilhos determinísticos que rodam ANTES da IA:
        // [{ match:'keyword', value:'corretor', action:'handoff'|'reply'|'close', reply_text }]
        triggers: { type: DataTypes.JSONB, allowNull: true, defaultValue: [] },
        // { message: 'texto avisando o lead da transferência' }
        handoff: { type: DataTypes.JSONB, allowNull: true, defaultValue: {} },
        // overrides: { debounce_seconds, max_ai_messages }
        settings: { type: DataTypes.JSONB, allowNull: true, defaultValue: {} },
    }, {
        sequelize,
        modelName: 'EmeAtendeFlow',
        tableName: 'eme_atende_flows',
        underscored: true,
        timestamps: true,
    });

    return EmeAtendeFlow;
};

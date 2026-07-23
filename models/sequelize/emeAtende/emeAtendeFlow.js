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
        // contexto de negócio MANUAL (complementa o automático do CV/ficha)
        business_context: { type: DataTypes.TEXT, allowNull: true },
        // vínculo com o empreendimento do CV (cv_enterprises.idempreendimento):
        // o contexto é montado AO VIVO a cada resposta (dados básicos + ficha
        // comercial aprovada mais recente) - ficha mudou, a Eme muda junto.
        cv_enterprise_id: { type: DataTypes.INTEGER, allowNull: true },
        // quais seções entram no contexto automático:
        // { basic, delivery, negotiation, subsidy, benefits, campaigns }
        // Comissão NUNCA entra (informação interna).
        context_sources: { type: DataTypes.JSONB, allowNull: true, defaultValue: { basic: true, delivery: true, negotiation: true, subsidy: true, benefits: true, campaigns: true } },
        // imagens que a Eme pode enviar na conversa (tool enviar_imagem):
        // [{ label: 'planta 2 quartos', url: 'https://...' }] - URL precisa ser pública
        images: { type: DataTypes.JSONB, allowNull: true, defaultValue: [] },
        // template Meta APROVADO que abre a conversa (validado em whatsapp_templates)
        opener_template: { type: DataTypes.STRING(120), allowNull: true },
        opener_language: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pt_BR' },
        // campos do lead que preenchem {{1}}, {{2}}... na ordem: ["name","empreendimento"]
        opener_variables: { type: DataTypes.JSONB, allowNull: true, defaultValue: [] },
        // gatilhos determinísticos que rodam ANTES da IA:
        // [{ match:'keyword', value:'quero visitar', action:'reply'|'close', reply_text }]
        triggers: { type: DataTypes.JSONB, allowNull: true, defaultValue: [] },
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

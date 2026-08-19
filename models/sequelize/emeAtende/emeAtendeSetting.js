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

        // URL base do site institucional lido pelo EmeAtendeSiteSource. Fica em
        // config (e não hardcoded) porque o domínio muda quando o site sair da
        // plataforma atual - trocar aqui não exige deploy.
        site_url: { type: DataTypes.STRING(255), allowNull: true },

        // ── Regras de atendimento (camada GERAL, vale pra todo fluxo) ────────
        // Editáveis na tela; o fluxo do empreendimento complementa/sobrescreve.
        // O piso de segurança (HARD_RULES) fica no código de propósito.
        global_persona: { type: DataTypes.TEXT, allowNull: true },
        global_rules:   { type: DataTypes.TEXT, allowNull: true },
        // Padrões estruturados: { max_sentences, questions_per_message, emoji,
        // formality, always_collect[], never_discuss[] } - ver emeAtendeRules.js
        standards:      { type: DataTypes.JSONB, allowNull: true, defaultValue: {} },

        // ── Modo teste (número fake) ─────────────────────────────────────────
        // Com test_mode=true a Eme Atende SÓ atende os números de test_phones —
        // qualquer outro externo segue na auto-resposta do Office. É como se
        // testa em produção sem risco de atender cliente de verdade.
        test_mode:   { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        test_phones: { type: DataTypes.JSONB,   allowNull: false, defaultValue: [] },

        // Rigor da checagem anti-alucinação sobre a resposta da IA:
        //   off         - só as regras do prompt
        //   money_dates - valores em dinheiro, percentuais e datas/prazos (padrão)
        //   strict      - qualquer número que não esteja no contexto
        validation_level: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'money_dates' },
    }, {
        sequelize,
        modelName: 'EmeAtendeSetting',
        tableName: 'eme_atende_settings',
        underscored: true,
        timestamps: true,
    });

    return EmeAtendeSetting;
};

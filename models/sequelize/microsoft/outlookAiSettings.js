// models/sequelize/microsoft/outlookAiSettings.js
//
// Como a IA trabalha a caixa de UMA pessoa. Uma linha por usuário.
//
// Não existe versão global disto de propósito: "meu jeito de escrever", "o que
// eu nunca decido por e-mail" e "até quanto ela pode responder sozinha" são
// respostas de cada pessoa. O que é da empresa (ligar o módulo, teto de
// mensagens por passada) mora em microsoft_settings, que é singleton.
export default (sequelize, DataTypes) => {
    const OutlookAiSettings = sequelize.define('OutlookAiSettings', {
        user_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'users', key: 'id' },
        },

        ativo: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: true,
            comment: 'Desligado, a IA não lê nem age nesta caixa. A aba Caixa continua funcionando.',
        },

        // ── Como ela escreve ─────────────────────────────────────────────────
        contexto: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'O que a IA sabe sobre o jeito de trabalhar da pessoa. Ela lê isto antes de escrever qualquer coisa no nome dela.',
        },
        tom: { type: DataTypes.STRING(40), allowNull: true, defaultValue: 'Direto' },
        temperatura: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 25,
            comment: '0 = repete o que a pessoa já escreveu; 100 = livre. Vira a temperature do modelo.',
        },

        // ── Até onde ela pode ir ─────────────────────────────────────────────
        nivel: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 2,
            comment: '1 só observa · 2 escreve e espera · 3 responde o rotineiro · 4 age por você. É TETO: rebaixa a matriz, nunca promove.',
        },
        teto_mil: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 150,
            comment: 'Valor em milhares de reais. E-mail que cita valor acima disto sempre pede aprovação. 0 = sempre pede.',
        },
        janela: {
            type: DataTypes.STRING(20),
            allowNull: true,
            defaultValue: 'comercial',
            comment: 'comercial (dias úteis 8h-19h) | sempre | manha. Fora dela, o envio automático fica segurado.',
        },
        matriz: {
            type: DataTypes.JSONB,
            allowNull: true,
            comment: 'O que fazer por importância: { critica, alta, media, ruido } → responder|aprovar|notificar|silenciar.',
        },
        limites: {
            type: DataTypes.JSONB,
            allowNull: true,
            comment: 'Assuntos sobre os quais ela nunca responde sozinha: [{ id, label, icon, on }].',
        },

        // ── O que vai LITERAL no e-mail ──────────────────────────────────────
        // Diferente de `contexto`: aquilo é prosa que o modelo interpreta, isto
        // é texto que ele COLA sem reescrever. Assinatura parafraseada não é
        // assinatura, e saudação "no espírito" da sua soa como outra pessoa.
        assinatura: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Bloco de assinatura, colado no fim sem o modelo reescrever.',
        },
        saudacao: {
            type: DataTypes.STRING(200),
            allowNull: true,
            comment: 'Como a pessoa abre o e-mail ("Bom dia, {nome}").',
        },
        despedida: {
            type: DataTypes.STRING(200),
            allowNull: true,
            comment: 'Como fecha antes da assinatura ("Abraço", "Att").',
        },

        // ── Janela de envio personalizada ────────────────────────────────────
        // Só valem quando `janela` = 'custom'.
        janela_inicio: { type: DataTypes.SMALLINT, allowNull: true, comment: 'Hora de abertura (0-23).' },
        janela_fim: { type: DataTypes.SMALLINT, allowNull: true, comment: 'Hora de fechamento (1-24).' },
        janela_dias: {
            type: DataTypes.JSONB,
            allowNull: true,
            comment: 'Dias da semana em que ela pode enviar: [0..6], 0 = domingo.',
        },

        // ── Escopo da leitura ────────────────────────────────────────────────
        escopo: {
            type: DataTypes.STRING(20),
            allowNull: true,
            defaultValue: 'tudo',
            comment: 'tudo = a caixa inteira (menos enviados/rascunhos/lixeira) · inbox = só a Caixa de Entrada.',
        },

        // ── Análise do contexto ──────────────────────────────────────────────
        ultima_analise_em: { type: DataTypes.DATE, allowNull: true },
        ultima_analise_base: { type: DataTypes.STRING(200), allowNull: true },
        sugestao_contexto: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Contexto proposto pela análise dos e-mails enviados, esperando a pessoa aceitar ou descartar.',
        },
        sugestao_base: { type: DataTypes.TEXT, allowNull: true },
    }, {
        tableName: 'outlook_ai_settings',
        underscored: true,
        timestamps: true,
    });

    OutlookAiSettings.associate = (models) => {
        OutlookAiSettings.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    };
    return OutlookAiSettings;
};

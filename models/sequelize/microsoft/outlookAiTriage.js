// models/sequelize/microsoft/outlookAiTriage.js
//
// O que a IA ENTENDEU de cada mensagem. Uma linha por (usuário, mensagem).
//
// Isto é cache, não registro de ação: reprocessar é de graça e não tem efeito
// fora do Office. O que a IA FEZ mora em outlook_ai_actions, que é o oposto -
// lá refazer manda e-mail duas vezes.
//
// `comportamento` é o resultado JÁ decidido (matriz da pessoa, rebaixada pelo
// nível de permissão, pelos assuntos protegidos e pelo teto de valor). Guardar
// o resultado e não só os ingredientes é o que permite a tela dizer "ia
// responder sozinha, mas seu nível 2 rebaixou para pedir OK" em `motivo_rebaixe`.
export default (sequelize, DataTypes) => {
    const OutlookAiTriage = sequelize.define('OutlookAiTriage', {
        user_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'users', key: 'id' },
        },
        message_id: { type: DataTypes.STRING(500), allowNull: false },
        conversation_id: { type: DataTypes.STRING(500), allowNull: true },

        // Cópia do cabeçalho: a tela monta a lista sem voltar ao Graph, e a
        // linha continua legível depois que a mensagem sai da caixa.
        assunto: { type: DataTypes.STRING(500), allowNull: true },
        remetente: { type: DataTypes.STRING(255), allowNull: true },
        remetente_nome: { type: DataTypes.STRING(255), allowNull: true },
        recebido_em: { type: DataTypes.DATE, allowNull: true },

        // ── A leitura ────────────────────────────────────────────────────────
        classe: {
            type: DataTypes.STRING(20),
            allowNull: true,
            comment: 'critica | alta | media | ruido — a linha da matriz que se aplica.',
        },
        intencao: { type: DataTypes.STRING(120), allowNull: true, comment: 'Pede decisão, pede aprovação, informa, cobra...' },
        prazo: { type: DataTypes.STRING(80), allowNull: true, comment: 'Como a pessoa lê: "até 29 ago".' },
        prazo_em: { type: DataTypes.DATEONLY, allowNull: true, comment: 'O mesmo prazo em data, para ordenar e virar compromisso.' },
        urgencia: { type: DataTypes.STRING(20), allowNull: true },
        porque: { type: DataTypes.TEXT, allowNull: true, comment: 'Por que ESTE e-mail precisa da pessoa. Uma frase.' },
        resumo: { type: DataTypes.TEXT, allowNull: true, comment: 'A leitura da IA mostrada acima do corpo.' },
        acao: { type: DataTypes.STRING(160), allowNull: true, comment: 'Rótulo curto da ação sugerida ("Aprovar o VGV").' },
        sugestoes: { type: DataTypes.JSONB, allowNull: true, comment: 'Respostas sugeridas: [{ label, corpo }].' },

        // ── O que rebaixa ────────────────────────────────────────────────────
        assuntos: { type: DataTypes.JSONB, allowNull: true, comment: 'Assuntos detectados, casados contra os limites da pessoa.' },
        valor_mil: { type: DataTypes.INTEGER, allowNull: true, comment: 'Maior valor citado, em milhares de reais. Null quando não cita.' },

        comportamento: {
            type: DataTypes.STRING(20),
            allowNull: true,
            comment: 'responder | aprovar | notificar | silenciar — já rebaixado.',
        },
        motivo_rebaixe: { type: DataTypes.STRING(240), allowNull: true },

        pasta: {
            type: DataTypes.STRING(200),
            allowNull: true,
            comment: 'Pasta em que a mensagem estava quando foi lida. Com escopo "tudo" a caixa não é só a inbox.',
        },

        // ── Saída da lista sem mentira ───────────────────────────────────────
        // "Adiar" devolve o e-mail amanhã. Quem já respondeu, ou passou para
        // outra pessoa, precisa TIRAR - e o motivo é o que ensina a IA a não
        // insistir no mesmo tipo de mensagem.
        resolvido_motivo: {
            type: DataTypes.STRING(40),
            allowNull: true,
            comment: 'ja_respondi | outra_pessoa | nao_precisa | resolvido_fora | adiado.',
        },
        resolvido_nota: { type: DataTypes.STRING(500), allowNull: true },
        resolvido_em: { type: DataTypes.DATE, allowNull: true },

        tratado: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
            comment: 'A IA já agiu sobre esta mensagem. Impede agir duas vezes na passada seguinte.',
        },
        fonte: {
            type: DataTypes.STRING(20),
            allowNull: false,
            defaultValue: 'ia',
            comment: 'ia | heuristica — sem chave do Gemini a triagem continua, só que por regra simples.',
        },
    }, {
        tableName: 'outlook_ai_triage',
        underscored: true,
        timestamps: true,
    });

    OutlookAiTriage.associate = (models) => {
        OutlookAiTriage.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    };
    return OutlookAiTriage;
};

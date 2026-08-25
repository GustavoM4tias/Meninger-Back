// models/sequelize/assistant/assistantTask.js
//
// Uma coisa que a pessoa precisa fazer. Diferente do Checklist, que é trabalho
// de equipe: isto é a lista do dia de UMA pessoa, e boa parte dela nasce sozinha
// de um e-mail, de um prazo que a IA achou ou de uma conversa sem resposta.
export default (sequelize, DataTypes) => {
    const AssistantTask = sequelize.define('AssistantTask', {
        user_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'users', key: 'id' },
        },
        titulo: { type: DataTypes.STRING(300), allowNull: false },
        detalhe: { type: DataTypes.TEXT, allowNull: true },

        // ── De onde veio ─────────────────────────────────────────────────────
        // É o que permite a tarefa levar DE VOLTA ao fato que a criou. Tarefa
        // que diz "responder a Julia" sem link para o e-mail obriga a pessoa a
        // procurar de novo o que o sistema já sabia.
        origem: {
            type: DataTypes.STRING(30),
            allowNull: false,
            defaultValue: 'manual',
            comment: 'manual | email | prazo | reuniao | teams | fila_ia',
        },
        origem_ref: {
            type: DataTypes.STRING(500),
            allowNull: true,
            comment: 'Id do e-mail, do evento ou da conversa. Chave anti-duplicata junto de origem.',
        },
        origem_link: { type: DataTypes.STRING(500), allowNull: true, comment: 'Rota do Office que abre o assunto.' },

        prazo: { type: DataTypes.DATE, allowNull: true },
        lembrar_em: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: 'Quando avisar. Vazio = só aparece na lista, sem cutucar.',
        },
        lembrete_enviado_em: { type: DataTypes.DATE, allowNull: true },

        // ── Vários avisos ────────────────────────────────────────────────────
        // Minutos ANTES do prazo, do mais distante ao mais próximo: [2880, 60]
        // é "dois dias antes e uma hora antes". `lembrar_em` é o próximo deles.
        avisos: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        avisos_enviados: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },

        // ── Acompanhamento ───────────────────────────────────────────────────
        // Tarefa que a pessoa não faz sozinha: depende de resposta de alguém.
        // O assistente volta a cutucar de N em N dias enquanto estiver aberta,
        // mesmo sem prazo - é o caso do "cobrar o Lúcio".
        acompanhar: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        acompanhar_cada: { type: DataTypes.SMALLINT, allowNull: true, defaultValue: 2 },
        acompanhado_em: { type: DataTypes.DATE, allowNull: true },

        estado: {
            type: DataTypes.STRING(20),
            allowNull: false,
            defaultValue: 'aberta',
            comment: 'aberta | concluida | descartada.',
        },
        concluida_em: { type: DataTypes.DATE, allowNull: true },
        motivo_descarte: { type: DataTypes.STRING(240), allowNull: true },

        prioridade: {
            type: DataTypes.SMALLINT,
            allowNull: false,
            defaultValue: 2,
            comment: '1 alta · 2 normal · 3 baixa. Ordena a lista junto do prazo.',
        },

        // ── Rotina ───────────────────────────────────────────────────────────
        // Concluir uma tarefa que repete cria a próxima. É o que permite
        // "conferir os boletos toda segunda" existir sem ninguém recriar à mão.
        repete: {
            type: DataTypes.STRING(20),
            allowNull: true,
            comment: 'diaria | semanal | quinzenal | mensal | dias_uteis.',
        },
        repete_ate: { type: DataTypes.DATEONLY, allowNull: true },
    }, {
        tableName: 'assistant_tasks',
        underscored: true,
        timestamps: true,
    });

    AssistantTask.associate = (models) => {
        AssistantTask.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    };
    return AssistantTask;
};

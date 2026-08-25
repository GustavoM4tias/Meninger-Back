// models/sequelize/microsoft/outlookAiQueue.js
//
// A fila do trilho lateral: o que a IA escreveu e está esperando o OK.
//
// Enquanto a linha está aqui com estado='pendente', NADA saiu da caixa. É esta
// tabela que sustenta a promessa do nível 2 ("escreve e espera"): a IA redige,
// grava aqui, e o e-mail só existe no mundo depois que a pessoa aprova.
//
// Ela guarda o texto, não um rascunho do Outlook, de propósito: rascunho no
// Outlook depende de Mail.ReadWrite (que o tenant ainda não concedeu) e ficaria
// visível na caixa como se a pessoa tivesse escrito. Aqui é da IA até o OK.
export default (sequelize, DataTypes) => {
    const OutlookAiQueue = sequelize.define('OutlookAiQueue', {
        user_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'users', key: 'id' },
        },
        message_id: {
            type: DataTypes.STRING(500),
            allowNull: true,
            comment: 'A mensagem que está sendo respondida. Null quando é cobrança que a IA começou.',
        },

        tipo: {
            type: DataTypes.STRING(40),
            allowNull: false,
            defaultValue: 'resposta',
            comment: 'resposta | cobranca.',
        },
        assunto: { type: DataTypes.STRING(500), allowNull: true },
        corpo: { type: DataTypes.TEXT, allowNull: true },
        destinatarios: { type: DataTypes.JSONB, allowNull: true, comment: 'Array de e-mails. A tela MOSTRA para quem vai antes do OK.' },
        motivo: {
            type: DataTypes.STRING(240),
            allowNull: true,
            comment: 'Por que caiu na fila em vez de sair sozinha ("assunto protegido: jurídico").',
        },

        estado: {
            type: DataTypes.STRING(20),
            allowNull: false,
            defaultValue: 'pendente',
            comment: 'pendente | aprovado | descartado.',
        },
    }, {
        tableName: 'outlook_ai_queue',
        underscored: true,
        timestamps: true,
    });

    OutlookAiQueue.associate = (models) => {
        OutlookAiQueue.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    };
    return OutlookAiQueue;
};

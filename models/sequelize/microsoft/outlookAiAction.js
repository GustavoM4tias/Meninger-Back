// models/sequelize/microsoft/outlookAiAction.js
//
// O que a IA FEZ na caixa. É o histórico que a aba Automações mostra e a base
// do "desfazer".
//
// `reversivel` não é enfeite: mover uma mensagem tem volta (guardamos a pasta de
// origem em desfazer_json), mandar e-mail não tem. Linha de envio nasce com
// reversivel=false e a tela NÃO oferece desfazer nela - oferecer seria mentira,
// e a regra da casa é que confirmação diz a consequência.
//
// `estado='bloqueado'` é o caso honesto do 403: a IA decidiu arquivar, o Graph
// recusou porque falta Mail.ReadWrite no Azure, e isso vira uma linha visível
// em vez de sumir num log.
export default (sequelize, DataTypes) => {
    const OutlookAiAction = sequelize.define('OutlookAiAction', {
        user_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'users', key: 'id' },
        },
        message_id: { type: DataTypes.STRING(500), allowNull: true },

        tipo: {
            type: DataTypes.STRING(40),
            allowNull: false,
            comment: 'triagem | arquivo | rascunho | resposta | agenda | resumo.',
        },
        titulo: { type: DataTypes.STRING(500), allowNull: true, comment: 'O assunto do e-mail, para a linha ser reconhecível.' },
        texto: { type: DataTypes.TEXT, allowNull: true, comment: 'O que ela fez, em uma frase.' },
        tag: { type: DataTypes.STRING(40), allowNull: true },

        estado: {
            type: DataTypes.STRING(20),
            allowNull: false,
            defaultValue: 'feito',
            comment: 'feito | desfeito | bloqueado (o Graph recusou, falta permissão).',
        },
        reversivel: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        desfazer_json: {
            type: DataTypes.JSONB,
            allowNull: true,
            comment: 'O que é preciso para reverter. Ex.: { pastaOrigem } de um arquivamento.',
        },
        erro: { type: DataTypes.TEXT, allowNull: true },
    }, {
        tableName: 'outlook_ai_actions',
        underscored: true,
        timestamps: true,
    });

    OutlookAiAction.associate = (models) => {
        OutlookAiAction.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    };
    return OutlookAiAction;
};

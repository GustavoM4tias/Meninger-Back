// models/sequelize/assistant/assistantNotice.js
//
// A marca de "isto já foi avisado".
//
// O lembrete de reunião guarda essa marca EM MEMÓRIA e assume que reavisar
// depois de um restart é aceitável. Aqui não é: o resumo do dia sai uma vez por
// pessoa por dia, e um deploy às 8h05 mandaria o segundo resumo para a empresa
// inteira. Por isso a marca é linha de banco, com índice único em
// (user_id, tipo, chave) - a chave costuma ser a data ou o id do que gerou.
export default (sequelize, DataTypes) => {
    const AssistantNotice = sequelize.define('AssistantNotice', {
        user_id: { type: DataTypes.INTEGER, allowNull: false },
        tipo: { type: DataTypes.STRING(40), allowNull: false, comment: 'resumo | prazo | parado.' },
        chave: { type: DataTypes.STRING(200), allowNull: false, comment: 'Data do dia, ou id da tarefa/mensagem.' },
        enviado_em: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    }, {
        tableName: 'assistant_notices',
        underscored: true,
        timestamps: false,
    });
    return AssistantNotice;
};

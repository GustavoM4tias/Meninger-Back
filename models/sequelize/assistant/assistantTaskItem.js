// models/sequelize/assistant/assistantTaskItem.js
//
// As partes de uma tarefa. "Lançar os títulos do Alelo" é a tarefa; "Marília" e
// "Sinop" são as partes.
//
// Sem isto a pessoa cria três tarefas quase iguais e perde a noção do todo -
// ou marca a tarefa inteira como feita com metade pendente, que é pior.
export default (sequelize, DataTypes) => {
    const AssistantTaskItem = sequelize.define('AssistantTaskItem', {
        task_id: { type: DataTypes.INTEGER, allowNull: false },
        titulo: { type: DataTypes.STRING(300), allowNull: false },
        feito: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        feito_em: { type: DataTypes.DATE, allowNull: true },
        feito_por_id: { type: DataTypes.INTEGER, allowNull: true, comment: 'Numa tarefa com parceiros, quem marcou.' },
        ordem: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    }, {
        tableName: 'assistant_task_items',
        underscored: true,
        timestamps: true,
    });

    AssistantTaskItem.associate = () => {};
    return AssistantTaskItem;
};

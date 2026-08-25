// models/sequelize/assistant/assistantTaskPartner.js
//
// Quem mais está nessa tarefa junto com o dono.
//
// `via` guarda COMO a pessoa entrou: 'direto' quando estava abaixo no
// organograma, 'convite' quando ela mesma aceitou. A diferença importa depois -
// numa cobrança, quem aceitou concordou; quem foi posto direto foi designado.
export default (sequelize, DataTypes) => {
    const AssistantTaskPartner = sequelize.define('AssistantTaskPartner', {
        task_id: { type: DataTypes.INTEGER, allowNull: false },
        user_id: { type: DataTypes.INTEGER, allowNull: false },
        adicionado_por_id: { type: DataTypes.INTEGER, allowNull: true },
        via: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'direto', comment: 'direto | convite' },
    }, {
        tableName: 'assistant_task_partners',
        underscored: true,
        timestamps: true,
    });

    AssistantTaskPartner.associate = (models) => {
        AssistantTaskPartner.belongsTo(models.User, { foreignKey: 'user_id', as: 'pessoa', constraints: false });
    };
    return AssistantTaskPartner;
};

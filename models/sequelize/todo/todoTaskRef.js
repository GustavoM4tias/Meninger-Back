// models/sequelize/todo/todoTaskRef.js
//
// Índice/enriquecimento LOCAL das tarefas do Microsoft To Do. O conteúdo da
// tarefa (título, prazo, etapas, anexos) vive no Microsoft (fonte de verdade);
// aqui guardamos só o vínculo com conceitos do Office (reunião/Teams,
// empreendimento) + um cache leve usado pelo dashboard e pelo futuro scheduler
// de notificação. Índices são criados de forma idempotente em ensureTodoSchema.
export default (sequelize, DataTypes) => {
    const TodoTaskRef = sequelize.define('TodoTaskRef', {
        user_id:    { type: DataTypes.INTEGER, allowNull: false },     // dono (users.id)
        ms_task_id: { type: DataTypes.STRING(255), allowNull: false }, // id da tarefa no Graph
        ms_list_id: { type: DataTypes.STRING(255), allowNull: false }, // id da lista no Graph

        // Cache leve (atualizado nas escritas) — evita chamar o Graph no scheduler.
        title_cache:      { type: DataTypes.TEXT,        allowNull: true },
        status_cache:     { type: DataTypes.STRING(40),  allowNull: true },
        due_cache:        { type: DataTypes.DATE,        allowNull: true },
        importance_cache: { type: DataTypes.STRING(20),  allowNull: true },

        // Anexos (URL / arquivo / SharePoint). O To Do nativo aceita só UM
        // linkedResource por tarefa, então a lista completa mora aqui e é exibida
        // rica no Office. Cada item: { id, webUrl, displayName, kind, createdAt }.
        attachments: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },

        // Vínculo com reunião / Teams gerada a partir da tarefa.
        meeting_event_id: { type: DataTypes.STRING(255), allowNull: true },
        meeting_join_url: { type: DataTypes.TEXT,        allowNull: true },
        meeting_subject:  { type: DataTypes.STRING(255), allowNull: true },

        // Vínculo opcional com empreendimento do CV (futuro).
        idempreendimento: { type: DataTypes.INTEGER,     allowNull: true },

        last_synced_at:   { type: DataTypes.DATE,        allowNull: true },
    }, {
        tableName: 'todo_task_refs',
        underscored: true,
        timestamps: true,
    });

    TodoTaskRef.associate = (models) => {
        TodoTaskRef.belongsTo(models.User, { as: 'user', foreignKey: 'user_id' });
    };

    return TodoTaskRef;
};

export default (sequelize, DataTypes) => {
    // Tarefa do checklist. parent_task_id != null => subtarefa.
    const ChecklistTask = sequelize.define('ChecklistTask', {
        checklist_id: { type: DataTypes.INTEGER, allowNull: false },
        section_id: { type: DataTypes.INTEGER, allowNull: false },
        parent_task_id: { type: DataTypes.INTEGER, allowNull: true }, // subtarefa
        category: { type: DataTypes.STRING(120), allowNull: true },
        title: { type: DataTypes.STRING(300), allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true }, // anotações
        status_id: { type: DataTypes.INTEGER, allowNull: true },
        // LOW | MEDIUM | HIGH | URGENT
        priority: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'MEDIUM' },
        value: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
        // ONE_TIME | MONTHLY (custos recorrentes do Excel: "MENSAL")
        value_kind: { type: DataTypes.STRING(20), allowNull: true },
        contracted_at: { type: DataTypes.DATEONLY, allowNull: true }, // data de contratação/cadastro
        due_date: { type: DataTypes.DATEONLY, allowNull: true },      // data para entrega/prevista
        started_at: { type: DataTypes.DATEONLY, allowNull: true },
        completed_at: { type: DataTypes.DATE, allowNull: true },      // setado ao entrar em state_class DONE
        assignee_user_id: { type: DataTypes.INTEGER, allowNull: true },
        assignee_label: { type: DataTypes.STRING(120), allowNull: true }, // fallback texto livre
        position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: DataTypes.INTEGER, allowNull: true },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'checklist_tasks',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['checklist_id'] },
            { fields: ['section_id'] },
            { fields: ['assignee_user_id'] },
            { fields: ['due_date'] },
            { fields: ['status_id'] },
            { fields: ['parent_task_id'] },
        ],
    });

    ChecklistTask.associate = (db) => {
        ChecklistTask.belongsTo(db.Checklist, { foreignKey: 'checklist_id', as: 'checklist' });
        ChecklistTask.belongsTo(db.ChecklistSection, { foreignKey: 'section_id', as: 'section' });
        ChecklistTask.belongsTo(db.ChecklistStatus, { foreignKey: 'status_id', as: 'statusRef', constraints: false });
        // Subtarefas (self-ref soft p/ nao travar deleção do pai).
        ChecklistTask.hasMany(db.ChecklistTask, { foreignKey: 'parent_task_id', as: 'subtasks', constraints: false });
        ChecklistTask.belongsTo(db.ChecklistTask, { foreignKey: 'parent_task_id', as: 'parent', constraints: false });
        ChecklistTask.hasMany(db.ChecklistTaskAttachment, { foreignKey: 'task_id', as: 'attachments', onDelete: 'CASCADE' });
        ChecklistTask.hasMany(db.ChecklistTaskComment, { foreignKey: 'task_id', as: 'comments', onDelete: 'CASCADE' });
        if (db.User) ChecklistTask.belongsTo(db.User, { foreignKey: 'assignee_user_id', as: 'assignee', constraints: false });
    };

    return ChecklistTask;
};

export default (sequelize, DataTypes) => {
    // Trilha de atividade/auditoria do checklist e suas tarefas. Alimenta a
    // timeline e serve de dedupe da cobrança (1 lembrete de atraso por dia).
    const ChecklistActivity = sequelize.define('ChecklistActivity', {
        checklist_id: { type: DataTypes.INTEGER, allowNull: false },
        task_id: { type: DataTypes.INTEGER, allowNull: true },
        user_id: { type: DataTypes.INTEGER, allowNull: true },
        // task.created | status_changed | assigned | due_changed | completed |
        // comment.added | attachment.added | nudge.sent | due_soon | overdue ...
        action: { type: DataTypes.STRING(60), allowNull: false },
        meta: { type: DataTypes.JSONB, allowNull: true },
    }, {
        tableName: 'checklist_activities',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['checklist_id'] },
            { fields: ['task_id'] },
            { fields: ['action'] },
        ],
    });

    ChecklistActivity.associate = (db) => {
        ChecklistActivity.belongsTo(db.Checklist, { foreignKey: 'checklist_id', as: 'checklist' });
        if (db.User) ChecklistActivity.belongsTo(db.User, { foreignKey: 'user_id', as: 'actor', constraints: false });
    };

    return ChecklistActivity;
};

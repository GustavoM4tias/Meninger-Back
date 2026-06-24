export default (sequelize, DataTypes) => {
    // Decisão de aprovação por usuário/perfil/rodada (proofing). Mantém o histórico
    // do fluxo: cada submissão p/ aprovação incrementa `round`; o cálculo olha o round atual.
    const ChecklistTaskApproval = sequelize.define('ChecklistTaskApproval', {
        task_id: { type: DataTypes.INTEGER, allowNull: false },
        profile_id: { type: DataTypes.INTEGER, allowNull: false },
        user_id: { type: DataTypes.INTEGER, allowNull: false },
        round: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
        // APPROVED | REJECTED
        decision: { type: DataTypes.STRING(20), allowNull: false },
        comment: { type: DataTypes.TEXT, allowNull: true },
    }, {
        tableName: 'checklist_task_approvals',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['task_id'] },
            { fields: ['profile_id'] },
            { fields: ['user_id'] },
        ],
    });

    ChecklistTaskApproval.associate = (db) => {
        ChecklistTaskApproval.belongsTo(db.ChecklistTask, { foreignKey: 'task_id', as: 'task' });
        if (db.User) ChecklistTaskApproval.belongsTo(db.User, { foreignKey: 'user_id', as: 'user', constraints: false });
    };

    return ChecklistTaskApproval;
};

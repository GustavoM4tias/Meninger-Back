export default (sequelize, DataTypes) => {
    // Comentário/discussão na tarefa. Suporta @menção (resolvida no service,
    // reusando o padrão mentionable do Academy) para notificar o citado.
    const ChecklistTaskComment = sequelize.define('ChecklistTaskComment', {
        task_id: { type: DataTypes.INTEGER, allowNull: false },
        user_id: { type: DataTypes.INTEGER, allowNull: false },
        body: { type: DataTypes.TEXT, allowNull: true }, // pode ser só imagem (marcação)
        // Imagem anexada ao comentário (ex.: marcação/proofing sobre um anexo).
        image_url: { type: DataTypes.TEXT, allowNull: true },
        annotated_from_id: { type: DataTypes.INTEGER, allowNull: true }, // anexo de origem da marcação
    }, {
        tableName: 'checklist_task_comments',
        timestamps: true,
        underscored: true,
        indexes: [{ fields: ['task_id'] }],
    });

    ChecklistTaskComment.associate = (db) => {
        ChecklistTaskComment.belongsTo(db.ChecklistTask, { foreignKey: 'task_id', as: 'task' });
        if (db.User) ChecklistTaskComment.belongsTo(db.User, { foreignKey: 'user_id', as: 'author', constraints: false });
    };

    return ChecklistTaskComment;
};

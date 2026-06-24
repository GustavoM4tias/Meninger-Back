export default (sequelize, DataTypes) => {
    // Anexo de tarefa (Supabase). kind=IMAGE => candidato à autorização/proofing
    // (Fase 3: marcar/desenhar sobre a imagem e gerar versão de autorização).
    const ChecklistTaskAttachment = sequelize.define('ChecklistTaskAttachment', {
        task_id: { type: DataTypes.INTEGER, allowNull: false },
        file_name: { type: DataTypes.STRING(300), allowNull: false },
        mime_type: { type: DataTypes.STRING(120), allowNull: true },
        url: { type: DataTypes.TEXT, allowNull: false },
        storage_path: { type: DataTypes.TEXT, allowNull: true },
        size: { type: DataTypes.BIGINT, allowNull: true },
        // FILE | IMAGE | LINK
        kind: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'FILE' },
        // Versão marcada (proofing): aponta para o anexo de imagem original.
        annotated_from_id: { type: DataTypes.INTEGER, allowNull: true },
        uploaded_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'checklist_task_attachments',
        timestamps: true,
        underscored: true,
        indexes: [{ fields: ['task_id'] }],
    });

    ChecklistTaskAttachment.associate = (db) => {
        ChecklistTaskAttachment.belongsTo(db.ChecklistTask, { foreignKey: 'task_id', as: 'task' });
    };

    return ChecklistTaskAttachment;
};

export default (sequelize, DataTypes) => {
    // Tarefa-padrão de um template. due_anchor + due_offset_days calculam a data
    // prevista da tarefa real a partir de um marco do checklist (ex.: 7 dias
    // antes da Abertura de Loja => anchor STORE_OPENING, offset -7).
    const ChecklistTemplateItem = sequelize.define('ChecklistTemplateItem', {
        template_id: { type: DataTypes.INTEGER, allowNull: false },
        section_id: { type: DataTypes.INTEGER, allowNull: false },
        parent_item_id: { type: DataTypes.INTEGER, allowNull: true }, // subitem
        title: { type: DataTypes.STRING(300), allowNull: false },
        category: { type: DataTypes.STRING(120), allowNull: true },
        default_priority: { type: DataTypes.STRING(20), allowNull: true, defaultValue: 'MEDIUM' },
        default_value: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
        // Dica de responsável (cargo/papel) a mapear para um usuário no instantiate.
        default_assignee_role: { type: DataTypes.STRING(120), allowNull: true },
        // Responsável padrão (usuário real) — vai direto p/ a tarefa criada.
        default_assignee_user_id: { type: DataTypes.INTEGER, allowNull: true },
        // TODAY | STORE_OPENING | MEETING | START
        due_anchor: { type: DataTypes.STRING(40), allowNull: true },
        due_offset_days: { type: DataTypes.INTEGER, allowNull: true },
        notes_template: { type: DataTypes.TEXT, allowNull: true },
        position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    }, {
        tableName: 'checklist_template_items',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['template_id'] },
            { fields: ['section_id'] },
        ],
    });

    ChecklistTemplateItem.associate = (db) => {
        ChecklistTemplateItem.belongsTo(db.ChecklistTemplate, { foreignKey: 'template_id', as: 'template' });
        ChecklistTemplateItem.belongsTo(db.ChecklistTemplateSection, { foreignKey: 'section_id', as: 'section' });
    };

    return ChecklistTemplateItem;
};

export default (sequelize, DataTypes) => {
    // Catálogo configurável de status. state_class normaliza qualquer label custom
    // para o cálculo de progresso/atraso. É o que permite "dezenas de checklists
    // com status diferentes" sem quebrar os agregados.
    const ChecklistStatus = sequelize.define('ChecklistStatus', {
        // GLOBAL | TEMPLATE
        scope: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'GLOBAL' },
        template_id: { type: DataTypes.INTEGER, allowNull: true },
        label: { type: DataTypes.STRING(80), allowNull: false },
        color: { type: DataTypes.STRING(20), allowNull: true },
        // TODO | IN_PROGRESS | BLOCKED | DONE | CANCELLED
        state_class: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'TODO' },
        position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    }, {
        tableName: 'checklist_statuses',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['scope'] },
            { fields: ['template_id'] },
            { fields: ['state_class'] },
        ],
    });

    ChecklistStatus.associate = (db) => {
        ChecklistStatus.hasMany(db.ChecklistTask, { foreignKey: 'status_id', as: 'tasks', constraints: false });
    };

    return ChecklistStatus;
};

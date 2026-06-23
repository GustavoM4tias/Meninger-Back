export default (sequelize, DataTypes) => {
    // Seção/divisão de uma instância de checklist.
    const ChecklistSection = sequelize.define('ChecklistSection', {
        checklist_id: { type: DataTypes.INTEGER, allowNull: false },
        name: { type: DataTypes.STRING(160), allowNull: false },
        color: { type: DataTypes.STRING(20), allowNull: true },
        position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    }, {
        tableName: 'checklist_sections',
        timestamps: true,
        underscored: true,
        indexes: [{ fields: ['checklist_id'] }],
    });

    ChecklistSection.associate = (db) => {
        ChecklistSection.belongsTo(db.Checklist, { foreignKey: 'checklist_id', as: 'checklist' });
        ChecklistSection.hasMany(db.ChecklistTask, { foreignKey: 'section_id', as: 'tasks', onDelete: 'CASCADE' });
    };

    return ChecklistSection;
};

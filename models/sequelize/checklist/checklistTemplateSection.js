export default (sequelize, DataTypes) => {
    // Seção/divisão padrão de um template (ex.: Engenharia e Comercial,
    // Agência - MKT, Interno - MKT).
    const ChecklistTemplateSection = sequelize.define('ChecklistTemplateSection', {
        template_id: { type: DataTypes.INTEGER, allowNull: false },
        name: { type: DataTypes.STRING(160), allowNull: false },
        color: { type: DataTypes.STRING(20), allowNull: true },
        position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    }, {
        tableName: 'checklist_template_sections',
        timestamps: true,
        underscored: true,
        indexes: [{ fields: ['template_id'] }],
    });

    ChecklistTemplateSection.associate = (db) => {
        ChecklistTemplateSection.belongsTo(db.ChecklistTemplate, { foreignKey: 'template_id', as: 'template' });
        ChecklistTemplateSection.hasMany(db.ChecklistTemplateItem, { foreignKey: 'section_id', as: 'items', onDelete: 'CASCADE' });
    };

    return ChecklistTemplateSection;
};

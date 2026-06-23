export default (sequelize, DataTypes) => {
    // Modelo reutilizável de checklist (biblioteca). Ex.: "Lançamento de
    // Empreendimento". Tem seções e itens-padrão que são copiados para uma
    // instância (Checklist) no momento da criação (instantiate).
    const ChecklistTemplate = sequelize.define('ChecklistTemplate', {
        name: { type: DataTypes.STRING(200), allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        // LAUNCH | GENERIC | (livre). Classifica o template na biblioteca.
        kind: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'GENERIC' },
        icon: { type: DataTypes.STRING(60), allowNull: true },
        color: { type: DataTypes.STRING(20), allowNull: true },
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        is_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        created_by: { type: DataTypes.INTEGER, allowNull: true },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'checklist_templates',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['kind'] },
            { fields: ['is_active'] },
        ],
    });

    ChecklistTemplate.associate = (db) => {
        ChecklistTemplate.hasMany(db.ChecklistTemplateSection, { foreignKey: 'template_id', as: 'sections', onDelete: 'CASCADE' });
        ChecklistTemplate.hasMany(db.ChecklistTemplateItem, { foreignKey: 'template_id', as: 'items', onDelete: 'CASCADE' });
        ChecklistTemplate.hasMany(db.ChecklistStatus, { foreignKey: 'template_id', as: 'statuses', constraints: false });
    };

    return ChecklistTemplate;
};

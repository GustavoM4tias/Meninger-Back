export default (sequelize, DataTypes) => {
    // Instância de checklist (ex.: "Lançamento - Três Marias - Ibitinga").
    // idempreendimento null => checklist avulso/genérico (display_name identifica).
    const Checklist = sequelize.define('Checklist', {
        template_id: { type: DataTypes.INTEGER, allowNull: true },
        title: { type: DataTypes.STRING(250), allowNull: false },
        kind: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'GENERIC' },
        idempreendimento: { type: DataTypes.INTEGER, allowNull: true },
        display_name: { type: DataTypes.STRING(200), allowNull: true },
        // Centro de custo: vincula manualmente p/ puxar dados depois (independe do CV).
        cost_center: { type: DataTypes.STRING(60), allowNull: true },
        // active | archived | done
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
        // Régua de cobrança: DEFAULT (usa a régua global) | CUSTOM (régua própria) | OFF
        reminder_mode: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'DEFAULT' },
        // Marcos/datas-chave: [{ key, label, date }] (ex.: meeting, store_opening).
        key_dates: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        owner_user_id: { type: DataTypes.INTEGER, allowNull: true },
        color: { type: DataTypes.STRING(20), allowNull: true },
        // Cache de agregados p/ o dashboard: { total, done, pct, overdue, budget }.
        progress_cache: { type: DataTypes.JSONB, allowNull: true },
        created_by: { type: DataTypes.INTEGER, allowNull: true },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'checklists',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['status'] },
            { fields: ['idempreendimento'] },
            { fields: ['owner_user_id'] },
            { fields: ['template_id'] },
        ],
    });

    Checklist.associate = (db) => {
        Checklist.belongsTo(db.ChecklistTemplate, { foreignKey: 'template_id', as: 'template', constraints: false });
        Checklist.hasMany(db.ChecklistSection, { foreignKey: 'checklist_id', as: 'sections', onDelete: 'CASCADE' });
        Checklist.hasMany(db.ChecklistTask, { foreignKey: 'checklist_id', as: 'tasks', onDelete: 'CASCADE' });
        Checklist.hasMany(db.ChecklistActivity, { foreignKey: 'checklist_id', as: 'activities', onDelete: 'CASCADE' });
        // Refs cross-módulo: soft (constraints:false) para nao acoplar o sync.
        if (db.CvEnterprise) Checklist.belongsTo(db.CvEnterprise, { foreignKey: 'idempreendimento', as: 'enterprise', constraints: false });
        if (db.User) Checklist.belongsTo(db.User, { foreignKey: 'owner_user_id', as: 'owner', constraints: false });
    };

    return Checklist;
};

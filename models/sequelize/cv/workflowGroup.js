export default (sequelize, DataTypes) => {
    const CvWorkflowGroup = sequelize.define('CvWorkflowGroup', {
        idgroup: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        tipo: { type: DataTypes.STRING(20), allowNull: false },
        nome: { type: DataTypes.STRING(100), allowNull: false },
        descricao: { type: DataTypes.STRING(255), allowNull: true },
        segmentos: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        situacoes_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // se no banco for jsonb; se for json, mantenha JSON
        ativo: { type: DataTypes.BOOLEAN, defaultValue: true },
        updated_at_cv: { type: DataTypes.DATE, allowNull: true }
    },{
        tableName: 'cv_workflow_groups',
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: 'updated_at'
    });

    return CvWorkflowGroup;
};

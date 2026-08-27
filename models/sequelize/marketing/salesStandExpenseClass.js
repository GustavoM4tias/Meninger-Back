export default (sequelize, DataTypes) => {
    // Classificação MANUAL de um lançamento do Sienge dentro de um stand.
    //
    // O gasto vem ao vivo do backup (não há tabela local de lançamento), então
    // o vínculo é pela chave estável do lançamento:
    //   expense_key = "<nutitulo>-<nuparcela>-<cdconta>"
    // A mesma nota paga em dois meses tem UMA linha aqui — classificar uma vez
    // vale para todos os meses em que ela aparece.
    //
    // Esta tabela VENCE o padrão da categoria da conta. Sem linha aqui, o
    // lançamento herda a categoria de sales_stand_expense_categories.
    const SalesStandExpenseClass = sequelize.define('SalesStandExpenseClass', {
        stand_id: { type: DataTypes.INTEGER, allowNull: false },
        expense_key: { type: DataTypes.STRING(80), allowNull: false },
        // construcao | recorrencia
        kind: { type: DataTypes.STRING(20), allowNull: false },
        category_id: { type: DataTypes.INTEGER, allowNull: true },
        classified_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'sales_stand_expense_classes',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['stand_id'] },
            { unique: true, fields: ['stand_id', 'expense_key'], name: 'sales_stand_expense_classes_stand_key_uk' },
        ],
    });

    SalesStandExpenseClass.associate = (db) => {
        SalesStandExpenseClass.belongsTo(db.SalesStand, { foreignKey: 'stand_id', as: 'stand' });
        SalesStandExpenseClass.belongsTo(db.SalesStandExpenseCategory, { foreignKey: 'category_id', as: 'category' });
    };

    return SalesStandExpenseClass;
};

export default (sequelize, DataTypes) => {
    // Categoria de gasto do Stand de Vendas.
    //
    // É a régua PADRÃO que diz, para cada conta do plano 2.02.07 do Sienge, se
    // aquele gasto é CONSTRUÇÃO (entra no custo de montar o stand) ou
    // RECORRÊNCIA (custo de manter o stand de pé, mês a mês).
    //
    // Serve como default: o lançamento herda a categoria da sua conta e, com
    // ela, o tipo. Quem cuida do stand pode reclassificar lançamento a
    // lançamento na tela (sales_stand_expense_classes vence esta tabela).
    //
    // A regra mora AQUI e é editável por tela — nada de lista fixa no código.
    const SalesStandExpenseCategory = sequelize.define('SalesStandExpenseCategory', {
        name: { type: DataTypes.STRING(80), allowNull: false },
        // construcao | recorrencia
        kind: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'recorrencia' },
        // ["2020702", "2020701", ...] — contas do plano financeiro que caem
        // nesta categoria por padrão. Uma conta só pode estar em uma categoria.
        conta_codes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        description: { type: DataTypes.STRING(300), allowNull: true },
        sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        created_by: { type: DataTypes.INTEGER, allowNull: true },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'sales_stand_expense_categories',
        timestamps: true,
        underscored: true,
        indexes: [{ fields: ['kind'] }],
    });

    return SalesStandExpenseCategory;
};

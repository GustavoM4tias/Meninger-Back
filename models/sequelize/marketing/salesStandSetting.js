export default (sequelize, DataTypes) => {
    // Configuração do módulo Stand de Vendas. Linha única (singleton).
    //
    // A pergunta que ela responde é a mais importante do módulo: O QUE conta
    // como gasto de stand no Sienge. Isso é regra de negócio e muda o número de
    // todas as telas, então mora aqui e se edita na tela — nunca em constante
    // de código.
    //
    //   'departamento' → o título tem apropriação no departamento Stand de
    //                    Vendas. O valor entra rateado pelo percentual dessa
    //                    apropriação. É quem MARCOU o título que decide.
    //   'plano'        → o título está apropriado numa conta do plano
    //                    2.02.07 (Despesas com Stand).
    //   'ambos'        → as duas coisas ao mesmo tempo (a régua mais apertada).
    //
    // Em qualquer modo, as CONTAS do plano continuam servindo para categorizar
    // o gasto (sales_stand_expense_categories).
    const SalesStandSetting = sequelize.define('SalesStandSetting', {
        // departamento | plano | ambos
        expense_source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'departamento' },
        // cddepartamento do Sienge — 25 = "Stand de Vendas".
        department_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 25 },
        // Prefixo do plano financeiro do stand — 20207 = "DESPESAS COM STAND".
        conta_prefix: { type: DataTypes.STRING(20), allowNull: false, defaultValue: '20207' },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'sales_stand_settings',
        timestamps: true,
        underscored: true,
    });

    return SalesStandSetting;
};

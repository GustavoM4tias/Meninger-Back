// models/sequelize/deptSpending/marketingDepartment.js
//
// Conjunto GLOBAL de departamentos (do Custos) cujo gasto é acompanhado na tela
// "Gastos por Departamento". presença + is_marketing=true => o gasto daquele
// department_name entra no acompanhamento. Pode ser sobreposto por empreendimento
// via dept_spending_enterprise_settings.marketing_dept_overrides.
//
// Fase 1: só o departamento de Marketing é acompanhado (orçamento = VGV × %). A
// estrutura já suporta múltiplos departamentos para as próximas fases. O nome da
// tabela é mantido (`viability_marketing_departments`) para preservar a config já
// cadastrada — o módulo Viabilidade foi reestruturado nesta tela.
export default (sequelize, DataTypes) => {
    const DeptSpendingMarketingDepartment = sequelize.define('DeptSpendingMarketingDepartment', {
        department_name: { type: DataTypes.STRING(120), primaryKey: true },
        is_marketing: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        updated_by: { type: DataTypes.STRING(120), allowNull: true },
    }, {
        tableName: 'viability_marketing_departments',
        underscored: true,
        timestamps: true,
    });

    return DeptSpendingMarketingDepartment;
};

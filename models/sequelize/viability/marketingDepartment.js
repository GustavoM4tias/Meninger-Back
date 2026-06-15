// models/sequelize/viability/marketingDepartment.js
//
// Conjunto GLOBAL de departamentos (do Custos) que contam como "marketing" na
// Viabilidade. presença + is_marketing=true => o gasto daquele department_name
// entra no gasto de marketing do relatório. Pode ser sobreposto por empreendimento
// via viability_enterprise_settings.marketing_dept_overrides. Ver [[project_viability]].
export default (sequelize, DataTypes) => {
    const ViabilityMarketingDepartment = sequelize.define('ViabilityMarketingDepartment', {
        department_name: { type: DataTypes.STRING(120), primaryKey: true },
        is_marketing: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        updated_by: { type: DataTypes.STRING(120), allowNull: true },
    }, {
        tableName: 'viability_marketing_departments',
        underscored: true,
        timestamps: true,
    });

    return ViabilityMarketingDepartment;
};

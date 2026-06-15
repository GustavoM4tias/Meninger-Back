// models/sequelize/viability/enterpriseSettings.js
//
// Configuração por empreendimento (chaveada pelo enterprise_key da projeção — que
// para CCs ERP é o próprio id do centro de custo):
//  - blocked_considered_available: quantas das unidades que o CV marca como
//    BLOQUEADAS devem ser consideradas disponíveis para marketing. Padrão 0
//    (bloqueada NÃO conta). Reservada sempre conta como disponível.
//  - marketing_dept_overrides: exceções ao conjunto global de departamentos de
//    marketing, no formato { "<department_name>": true|false }.
// Ver [[project_viability]].
export default (sequelize, DataTypes) => {
    const ViabilityEnterpriseSettings = sequelize.define('ViabilityEnterpriseSettings', {
        enterprise_key: { type: DataTypes.STRING(80), primaryKey: true },
        blocked_considered_available: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        marketing_dept_overrides: { type: DataTypes.JSONB, allowNull: true },
        updated_by: { type: DataTypes.STRING(120), allowNull: true },
    }, {
        tableName: 'viability_enterprise_settings',
        underscored: true,
        timestamps: true,
    });

    return ViabilityEnterpriseSettings;
};

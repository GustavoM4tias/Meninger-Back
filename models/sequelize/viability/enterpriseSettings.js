// models/sequelize/viability/enterpriseSettings.js
//
// Configuração por EMPRESA Sienge (= empreendimento), chaveada por company_id
// (enterprise_cities.raw_payload.idCompany). O relatório agrupa os CCs por empresa,
// então a config de unidades e de departamentos vive nesse nível:
//  - blocked_considered_available: quantas das unidades que o CV marca como
//    BLOQUEADAS devem ser consideradas disponíveis para marketing. Padrão 0
//    (bloqueada NÃO conta). Reservada sempre conta como disponível.
//  - marketing_dept_overrides: exceções ao conjunto global de departamentos de
//    marketing, no formato { "<department_name>": true|false }.
// Ver [[project_viability]].
export default (sequelize, DataTypes) => {
    const ViabilityEnterpriseSettings = sequelize.define('ViabilityEnterpriseSettings', {
        company_id: { type: DataTypes.INTEGER, primaryKey: true },
        blocked_considered_available: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        marketing_dept_overrides: { type: DataTypes.JSONB, allowNull: true },
        // Categoria manual: 'concluido' | 'em_andamento' | 'previsao_futura' | null (automático).
        status_override: { type: DataTypes.STRING(20), allowNull: true },
        updated_by: { type: DataTypes.STRING(120), allowNull: true },
    }, {
        tableName: 'viability_enterprise_settings',
        underscored: true,
        timestamps: true,
    });

    return ViabilityEnterpriseSettings;
};

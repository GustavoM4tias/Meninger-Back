// models/sequelize/deptSpending/enterpriseSettings.js
//
// Configuração + LIBERAÇÃO por EMPRESA Sienge (= empreendimento), chaveada por
// company_id (enterprise_cities.raw_payload.idCompany). O relatório agrupa os CCs
// por empresa, então config e governança vivem nesse nível.
//
// Config (herdada da Viabilidade):
//  - blocked_considered_available: quantas das unidades que o CV marca como
//    BLOQUEADAS considerar disponíveis. Padrão 0. Reservada sempre conta.
//  - marketing_dept_overrides: exceções ao conjunto global de departamentos
//    acompanhados, no formato { "<department_name>": true|false }.
//  - status_override: categoria manual do empreendimento (null = automático).
//
// Governança "rascunho → liberado" (NOVO):
//  - is_released: enquanto false, o empreendimento fica em RASCUNHO e só o admin
//    (backoffice) enxerga. Ao ficar 100%, o admin marca liberado e a diretoria
//    passa a ver. Liberação é por empreendimento.
//  - released_by / released_at / release_notes: trilha de quem liberou e quando.
//
// Nome da tabela mantido (`viability_enterprise_settings`) para preservar a config
// já cadastrada — o módulo Viabilidade foi reestruturado nesta tela.
export default (sequelize, DataTypes) => {
    const DeptSpendingEnterpriseSettings = sequelize.define('DeptSpendingEnterpriseSettings', {
        company_id: { type: DataTypes.INTEGER, primaryKey: true },
        blocked_considered_available: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        marketing_dept_overrides: { type: DataTypes.JSONB, allowNull: true },
        // Categoria manual: 'concluido' | 'em_andamento' | 'pre_lancamento' | 'previsao_futura' | null (automático).
        status_override: { type: DataTypes.STRING(20), allowNull: true },
        // Governança de liberação (rascunho → liberado), por empreendimento.
        is_released: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        released_by: { type: DataTypes.STRING(120), allowNull: true },
        released_at: { type: DataTypes.DATE, allowNull: true },
        release_notes: { type: DataTypes.TEXT, allowNull: true },
        updated_by: { type: DataTypes.STRING(120), allowNull: true },
    }, {
        tableName: 'viability_enterprise_settings',
        underscored: true,
        timestamps: true,
    });

    return DeptSpendingEnterpriseSettings;
};

// models/sequelize/deptSpending/stageSettings.js
//
// Configuração + LIBERAÇÃO por EMPREENDIMENTO (etapa), chaveada por
// enterprise_key da projeção ativa (= centro de custo do Sienge).
//
// Uma empresa Sienge (SPE) costuma ter VÁRIAS etapas em CCs diferentes, cada uma
// com o seu % de marketing e a sua verba. A tela lista uma linha por etapa, então
// o que é decisão de etapa mora aqui:
//  - is_released / released_by / released_at / release_notes: governança
//    "rascunho → liberado" (enquanto false só o admin enxerga).
//  - status_override: categoria manual (null = automático).
//  - report_insights: cache da "Leitura para decisão" (IA) do relatório da etapa.
//
// O que continua sendo decisão de EMPRESA (departamentos acompanhados, bucket
// Loja, bloqueadas consideradas disponíveis) segue em `viability_enterprise_settings`.
// Sem linha aqui, o resolver cai no ajuste da empresa (compatibilidade).
export default (sequelize, DataTypes) => {
    const DeptSpendingStageSettings = sequelize.define('DeptSpendingStageSettings', {
        enterprise_key: { type: DataTypes.STRING(60), primaryKey: true },
        company_id: { type: DataTypes.INTEGER, allowNull: true },
        // Categoria manual: 'concluido' | 'em_andamento' | 'pre_lancamento' | 'previsao_futura' | null (automático).
        status_override: { type: DataTypes.STRING(20), allowNull: true },
        is_released: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        released_by: { type: DataTypes.STRING(120), allowNull: true },
        released_at: { type: DataTypes.DATE, allowNull: true },
        release_notes: { type: DataTypes.TEXT, allowNull: true },
        // { month, hash, generatedAt, source, blocks: [{ title, tone, text }] }
        report_insights: { type: DataTypes.JSONB, allowNull: true },
        updated_by: { type: DataTypes.STRING(120), allowNull: true },
    }, {
        tableName: 'viability_stage_settings',
        underscored: true,
        timestamps: true,
    });

    return DeptSpendingStageSettings;
};

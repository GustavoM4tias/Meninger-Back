// models/sequelize/comercial/salesClosingDivergence.js
//
// Divergência detectada entre o snapshot de um mês consolidado e o estado
// atual dos insumos (contratos/regras). Cada linha responde "o que mudou,
// em qual contrato, de que valor para que valor e quando foi detectado".
export default (sequelize, DataTypes) => {
    const SalesClosingDivergence = sequelize.define(
        'SalesClosingDivergence',
        {
            id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            closing_id: { type: DataTypes.INTEGER, allowNull: false },
            period: { type: DataTypes.STRING(7), allowNull: false },
            // contract_changed | contract_added | contract_removed | rules_changed
            kind: { type: DataTypes.STRING(30), allowNull: false },
            contract_id: { type: DataTypes.BIGINT, allowNull: true },
            field: { type: DataTypes.STRING(60), allowNull: true },
            old_value: { type: DataTypes.TEXT, allowNull: true },
            new_value: { type: DataTypes.TEXT, allowNull: true },
            // contexto p/ leitura humana: cliente, unidade, empreendimento, impacto
            details: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            // 30 e não 20: 'reconsolidated' cabe com folga (o valor antigo
            // 'resolved_by_reconsolidation' estourava varchar(20)).
            status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'open' },
            detected_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            reviewed_at: { type: DataTypes.DATE, allowNull: true },
            reviewed_by_id: { type: DataTypes.INTEGER, allowNull: true }
        },
        {
            tableName: 'sales_closing_divergences',
            underscored: true,
            indexes: [
                { fields: ['closing_id'] },
                { fields: ['period'] },
                { fields: ['status'] }
            ]
        }
    );
    return SalesClosingDivergence;
};

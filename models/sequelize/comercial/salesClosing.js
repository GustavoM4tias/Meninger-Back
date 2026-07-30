// models/sequelize/comercial/salesClosing.js
//
// Fechamento (consolidação) mensal de vendas do Faturamento.
// O snapshot congela os números que o admin viu no dashboard no momento do
// fechamento (mesmo motor de cálculo do front) + a fotografia dos INSUMOS
// (contratos e regras) feita pelo servidor, usada pela vigilância diária para
// detectar e explicar qualquer mudança posterior.
export default (sequelize, DataTypes) => {
    const SalesClosing = sequelize.define(
        'SalesClosing',
        {
            id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            // 'YYYY-MM'
            period: { type: DataTypes.STRING(7), allowNull: false, unique: true },
            status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'consolidado' },
            version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
            consolidated_at: { type: DataTypes.DATE, allowNull: true },
            consolidated_by_id: { type: DataTypes.INTEGER, allowNull: true },
            consolidated_by_name: { type: DataTypes.STRING, allowNull: true },
            // { count, vgv_net, vgv_gross, by_enterprise: [...], by_company: [...] }
            totals: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            // linha a linha (venda): contratos, cliente, unidade, empreendimento,
            // empresa, valores net/gross, distratada, data
            lines: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
            // fotografia dos insumos no momento do fechamento (server-side):
            // { contracts: { [id]: {...campos relevantes...} }, rules: { [tabela]: hash } }
            inputs_snapshot: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            // versões anteriores (reconsolidação): [{ version, consolidated_at, by, totals }]
            history: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
            notes: { type: DataTypes.TEXT, allowNull: true }
        },
        { tableName: 'sales_closings', underscored: true }
    );
    return SalesClosing;
};

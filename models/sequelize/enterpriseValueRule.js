// models/sequelize/enterpriseValueRule.js
//
// Regras de composição de VGV por empreendimento (Faturamento / Vendas × Projeção).
//
// Substitui o antigo ENTERPRISE_OVERRIDES que vivia hardcoded no contractsStore
// do front. Cada linha diz COMO o valor de um empreendimento deve ser somado:
//
//   FULL             → soma normal das condições de pagamento (padrão)
//   LAND_VALUE_ONLY  → usa apenas o land_value do contrato
//   TR_ONLY          → soma apenas as condições de Terreno (TR)
//
// gross_mode e net_mode são independentes: um empreendimento pode usar
// LAND_VALUE_ONLY no VGV+DC e FULL no VGV, por exemplo.
export default (sequelize, DataTypes) => {
    return sequelize.define('EnterpriseValueRule', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        enterprise_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
        enterprise_name: { type: DataTypes.STRING, allowNull: true },
        // STRING (não ENUM) para não travar o sync({ alter: true }).
        gross_mode: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'FULL' },
        net_mode: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'FULL' },
        description: { type: DataTypes.STRING(255), allowNull: true },
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
    }, {
        tableName: 'enterprise_value_rules',
        underscored: true,
        timestamps: true
    })
}

// models/sequelize/sienge/launchTypeConfig.js
export default (sequelize, DataTypes) => {
    const LaunchTypeConfig = sequelize.define(
        'LaunchTypeConfig',
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },

            // Nome exibido ao usuário (ex: "Marketing", "ITBI")
            name: {
                type: DataTypes.STRING(100),
                allowNull: false,
                unique: true,
            },

            // Código do documento no Sienge (ex: "CT", "PCEF", "ITBI")
            documento: {
                type: DataTypes.STRING(20),
                allowNull: false,
            },

            // Item do orçamento
            budgetItem: {
                field: 'budget_item',
                type: DataTypes.STRING(200),
                allowNull: false,
            },
            budgetItemCode: {
                field: 'budget_item_code',
                type: DataTypes.STRING(20),
                allowNull: true,
            },

            // Conta financeira
            financialAccountNumber: {
                field: 'financial_account_number',
                type: DataTypes.STRING(50),
                allowNull: false,
            },

            // Índices para o Playwright (posição na planilha do Sienge)
            budgetIndex: {
                field: 'budget_index',
                type: DataTypes.INTEGER,
                allowNull: true,
                comment: 'Índice 1-based do item de orçamento na planilha Sienge',
            },
            accountIndex: {
                field: 'account_index',
                type: DataTypes.INTEGER,
                allowNull: true,
                comment: 'Índice 1-based da conta financeira no modal Sienge',
            },

            // ID do departamento no Sienge (ex: '24' Comercial, '25' Stand/Consumo, '16' Marketing)
            departamentoId: {
                field: 'departamento_id',
                type: DataTypes.STRING(10),
                allowNull: true,
                comment: 'ID do departamento no Sienge (ex: 24, 25, 16). Quando preenchido, sobrescreve o mapa legado.',
            },

            active: {
                type: DataTypes.BOOLEAN,
                defaultValue: true,
                allowNull: false,
            },

            createdBy: {
                field: 'created_by',
                type: DataTypes.INTEGER,
                allowNull: true,
            },
        },
        {
            tableName: 'launch_type_configs',
            underscored: true,
            timestamps: true,
        }
    );

    LaunchTypeConfig.associate = (_models) => { };
    return LaunchTypeConfig;
};

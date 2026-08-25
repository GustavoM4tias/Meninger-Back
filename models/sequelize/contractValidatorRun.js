// models/sequelize/contractValidatorRun.js
//
// Uma linha por execução da análise automática de contratos. Existe porque o
// job era invisível: quando ele parava (ou rodava e falhava antes de chamar o
// modelo), NADA no banco mudava, e a única forma de descobrir era comparar o
// histórico de validações com a fila do CV na mão.
export default (sequelize, DataTypes) => {
    const ContractValidatorRun = sequelize.define('ContractValidatorRun', {
        origin: {
            type: DataTypes.STRING,          // 'agendado' | 'manual'
            allowNull: false,
            defaultValue: 'agendado',
        },
        found: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        processed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        errors: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        // Só preenchida quando a execução INTEIRA falha (o erro de um repasse
        // isolado vira mensagem no CV e conta em `errors`).
        message: { type: DataTypes.TEXT, allowNull: true },
        started_at: { type: DataTypes.DATE, allowNull: false },
        finished_at: { type: DataTypes.DATE, allowNull: true },
    }, {
        tableName: 'contract_validator_runs',
        underscored: true,
    });

    return ContractValidatorRun;
};

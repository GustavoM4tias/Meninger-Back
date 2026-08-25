// models/sequelize/contractValidatorStuck.js
//
// O que está preso em "Analise Contratos" e por quê. Quando a análise dá ERRO
// o repasse fica DE PROPÓSITO na mesma etapa (só recebe mensagem no CV), e sem
// este registro ninguém fica sabendo: o contrato espera calado enquanto o job
// repete a mesma falha a cada ciclo.
export default (sequelize, DataTypes) => {
    const ContractValidatorStuck = sequelize.define('ContractValidatorStuck', {
        idrepasse: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: false },
        idreserva: { type: DataTypes.INTEGER, allowNull: true },
        cliente: { type: DataTypes.STRING, allowNull: true },
        empreendimento: { type: DataTypes.STRING, allowNull: true },
        // Desde quando ele está na etapa, segundo o próprio CV.
        status_since: { type: DataTypes.DATE, allowNull: true },
        last_error: { type: DataTypes.TEXT, allowNull: true },
        attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        // Um aviso por episódio: o registro sai da tabela quando o repasse anda.
        alerted_at: { type: DataTypes.DATE, allowNull: true },
    }, {
        tableName: 'contract_validator_stuck',
        underscored: true,
    });

    return ContractValidatorStuck;
};

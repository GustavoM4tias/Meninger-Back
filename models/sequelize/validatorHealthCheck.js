// models/sequelize/validatorHealthCheck.js
//
// Uma linha por checagem de saúde do Validador. Existe pelo mesmo motivo do
// contract_validator_runs: sem rastro, "a sonda não rodou" e "a sonda rodou e
// achou tudo bem" ficam idênticos vistos do banco - e é justamente a sonda
// parada que ninguém percebe.
//
// `checks` guarda o detalhe do que foi conferido, para a tela mostrar QUAL item
// derrubou o status em vez de só a cor do farol.
export default (sequelize, DataTypes) => {
    const ValidatorHealthCheck = sequelize.define('ValidatorHealthCheck', {
        // 'agendado' | 'manual' | 'boot'
        origin: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'agendado' },
        // 'ok' | 'degraded' | 'down'
        status: { type: DataTypes.STRING(16), allowNull: false },
        ms: { type: DataTypes.INTEGER, allowNull: true },
        // { modelos: [...], api: {...}, webhook: {...}, fila: {...} }
        checks: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        message: { type: DataTypes.TEXT, allowNull: true },
    }, {
        tableName: 'validator_health_checks',
        underscored: true,
    });

    return ValidatorHealthCheck;
};

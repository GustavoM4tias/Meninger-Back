// models/sequelize/boleto/boletoEcoLock.js
//
// Mutex de uso da sessão Ecobrança. Singleton id=1. Concorrência entre
// emissão (webhook do CV) e scheduler de payment check (cron diário às 8h)
// pode logar 2 sessões na mesma conta e a Caixa expulsa uma delas.
//
// Quem vai usar Ecobrança chama acquire(); se conseguir, segue. Se não,
// pula a rodada (scheduler) ou aguarda (emissão). Lock expira por TTL pra
// evitar deadlock se o processo travar/cair.

export default (sequelize, DataTypes) => {
    const BoletoEcoLock = sequelize.define('BoletoEcoLock', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        owner: {
            type: DataTypes.STRING(120),
            allowNull: true,
            comment: 'Quem está com o lock: "emit:reserva-1234", "check:scheduler:<iso>", etc. 120 chars cobre identificadores com ISO timestamp e id de história.',
        },
        locked_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },
        expires_at: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: 'TTL — se NOW() > expires_at, lock é considerado liberado.',
        },
    }, {
        tableName: 'boleto_eco_lock',
        underscored: true,
        timestamps: true,
    });

    BoletoEcoLock.associate = () => {};
    return BoletoEcoLock;
};

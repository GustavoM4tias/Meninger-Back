// models/sequelize/cv/integrationEvent.js
//
// Histórico da integração com o CV: uma linha por EXECUÇÃO, de qualquer
// origem. Complementa `cv_sync_state`, que guarda só o estado atual de cada
// job (uma linha, sobrescrita) e por isso nunca respondeu "o que aconteceu
// antes da última rodada".
//
// Serve as três origens de propósito: cron, webhook e disparo manual pela
// tela. É o que permite comparar "o CV entregou por webhook" contra "o cron
// achou depois", que é a medida de confiança para rebaixar o cron a validador.

export default (sequelize, DataTypes) => {
    const CvIntegrationEvent = sequelize.define('CvIntegrationEvent', {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },

        origem: {
            type: DataTypes.STRING(20),
            allowNull: false,
            comment: 'webhook | cron | manual',
        },
        funcionalidade: {
            type: DataTypes.STRING(40),
            allowNull: false,
            comment: 'reservas | repasses | leads | precadastros | ...',
        },
        entidade_id: {
            type: DataTypes.INTEGER,
            comment: 'idreserva / idrepasse quando o evento é de um registro só',
        },
        status: {
            type: DataTypes.STRING(20),
            allowNull: false,
            comment: 'ok | erro | ignorado | duplicado | parcial | escuta',
        },
        mensagem: { type: DataTypes.TEXT },
        duracao_ms: { type: DataTypes.INTEGER },

        // Corpo cru do webhook. É o que permite descobrir o formato real que o
        // CV manda sem depender de documentação - e auditar depois o que
        // chegou, quando um caso der errado.
        payload: { type: DataTypes.JSONB },
        stats: { type: DataTypes.JSONB },
    }, {
        tableName: 'cv_integration_events',
        underscored: true,
        timestamps: true,
        updatedAt: false,
    });

    return CvIntegrationEvent;
};

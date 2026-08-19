// /models/sequelize/pushSubscription.js
//
// Um registro por APARELHO (não por usuário): a mesma pessoa pode ter o Office
// instalado no iPhone, no Mac e no Chrome do desktop e receber nos três.
//
// O endpoint é a identidade da inscrição no serviço de push do navegador. Ele
// pode rodar sozinho (o navegador troca por sua conta), por isso o front
// revalida a inscrição a cada boot — ver src/utils/Pwa/push.js.
import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
    class PushSubscription extends Model {
        static associate(models) {
            PushSubscription.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
        }
    }

    PushSubscription.init({
        user_id: { type: DataTypes.INTEGER, allowNull: false },
        // STRING(512) e não TEXT de propósito: precisa de índice único e o
        // btree do Postgres tem limite de tamanho por entrada.
        endpoint: { type: DataTypes.STRING(512), allowNull: false },
        p256dh: { type: DataTypes.STRING(255), allowNull: false },
        auth: { type: DataTypes.STRING(255), allowNull: false },
        user_agent: { type: DataTypes.STRING(400), allowNull: true },
        // true = inscrito de dentro do app instalado. No iPhone só existe assim.
        standalone: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        last_success_at: { type: DataTypes.DATE, allowNull: true },
        failure_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    }, {
        sequelize,
        modelName: 'PushSubscription',
        tableName: 'push_subscriptions',
        underscored: true,
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        indexes: [
            { unique: true, fields: ['endpoint'], name: 'push_subscriptions_endpoint_uniq' },
            { fields: ['user_id'], name: 'push_subscriptions_user_idx' },
        ],
    });

    return PushSubscription;
};

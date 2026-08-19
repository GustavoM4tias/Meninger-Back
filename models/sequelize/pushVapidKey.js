// /models/sequelize/pushVapidKey.js
//
// Par de chaves VAPID do Web Push. Linha única.
//
// Fica no banco, e não só em env, para não exigir passo manual: no primeiro
// boot sem chave o lib/ensureVapidKeys.js gera e grava (ver a memória "nada de
// script manual"). Se VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY existirem no ambiente,
// elas mandam e esta tabela é ignorada.
//
// ⚠️ Trocar a chave invalida TODAS as inscrições existentes: os aparelhos
// precisam se reinscrever. Por isso nunca é regerada automaticamente.
import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
    class PushVapidKey extends Model { }

    PushVapidKey.init({
        public_key: { type: DataTypes.STRING(255), allowNull: false },
        private_key: { type: DataTypes.STRING(255), allowNull: false },
        subject: { type: DataTypes.STRING(255), allowNull: false },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    }, {
        sequelize,
        modelName: 'PushVapidKey',
        tableName: 'push_vapid_keys',
        underscored: true,
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: 'updated_at',
    });

    return PushVapidKey;
};

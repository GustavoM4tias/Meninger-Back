// models/sequelize/emeAtende/emeAtendeApiKey.js
//
// Chaves de API pro intake público de leads da Eme Atende (POST /api/eme-atende/public/leads).
// Guarda só o sha256 - a key em claro aparece uma única vez, na criação.

import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
    class EmeAtendeApiKey extends Model {}

    EmeAtendeApiKey.init({
        name: { type: DataTypes.STRING(120), allowNull: false },
        key_hash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        last_used_at: { type: DataTypes.DATE, allowNull: true },
    }, {
        sequelize,
        modelName: 'EmeAtendeApiKey',
        tableName: 'eme_atende_api_keys',
        underscored: true,
        timestamps: true,
    });

    return EmeAtendeApiKey;
};

// models/sequelize/emeAtende/emeAtendeFlowRule.js
//
// Segmentação da base: regra ordenada (campo/operador/valor) → fluxo.
// Primeira que casa vence; sem match, o lead cai no fluxo default.

import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
    class EmeAtendeFlowRule extends Model {}

    EmeAtendeFlowRule.init({
        priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },
        // campo do lead: source | campaign | empreendimento | name | email | chave do payload
        field: { type: DataTypes.STRING(80), allowNull: false },
        operator: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'contains' }, // equals|contains|regex
        value: { type: DataTypes.STRING(255), allowNull: false },
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        flow_id: { type: DataTypes.INTEGER, allowNull: false },
    }, {
        sequelize,
        modelName: 'EmeAtendeFlowRule',
        tableName: 'eme_atende_flow_rules',
        underscored: true,
        timestamps: true,
    });

    return EmeAtendeFlowRule;
};

// models/sequelize/emeAtende/emeAtendeSiteSync.js
//
// Histórico das leituras do site institucional. Existe por um motivo prático: o
// conteúdo que a Eme fala com o lead passou a vir de fora, atualizado sozinho de
// madrugada. Sem histórico, "a Eme começou a dizer outra coisa" viraria
// investigação - aqui dá pra ver o dia em que mudou e o que mudou.
//
// Guarda o RESULTADO de cada rodada, não o conteúdo: o snapshot vigente fica no
// fluxo. `changes` registra quais campos mudaram por fluxo (e a contagem de
// imagens antes/depois), que é o suficiente pra explicar a mudança sem estufar a
// tabela com cópias do site inteiro.

import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
    class EmeAtendeSiteSync extends Model {}

    EmeAtendeSiteSync.init({
        // scheduler | manual | vinculo (quando o admin liga o fluxo ao site)
        trigger: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'scheduler' },
        site_url: { type: DataTypes.STRING(255), allowNull: true },
        ok: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        total_flows: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        synced: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        // slugs que o fluxo aponta mas o site não tem mais
        missing: { type: DataTypes.JSONB, allowNull: true, defaultValue: [] },
        // [{ flow_id, name, slug, fields: ['sobre','images'], images: [10, 12] }]
        changes: { type: DataTypes.JSONB, allowNull: true, defaultValue: [] },
        duration_ms: { type: DataTypes.INTEGER, allowNull: true },
        error: { type: DataTypes.TEXT, allowNull: true },
    }, {
        sequelize,
        modelName: 'EmeAtendeSiteSync',
        tableName: 'eme_atende_site_syncs',
        underscored: true,
        timestamps: true,
        updatedAt: false,
    });

    return EmeAtendeSiteSync;
};

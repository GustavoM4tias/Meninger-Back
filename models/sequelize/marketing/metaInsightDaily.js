// models/sequelize/marketing/metaInsightDaily.js
//
// Série DIÁRIA de insights da Meta, por nível da hierarquia:
//   entity_level = 'campaign' | 'adset' | 'ad'
//
// É a fonte dos relatórios por período: qualquer janela (hoje, 7d, mês passado)
// é respondida somando os dias localmente — sem depender da janela do último
// sync (que era o problema dos agregados fixos em meta_campaigns/meta_ads).
//
// Alimentada por MetaInsightsDailyService.syncDaily() via
// /act_x/insights?level=X&time_increment=1 (1 chamada paginada por conta/nível).
//
// Estratégia de escrita: delete+insert por (conta, nível, janela) em transação —
// idempotente e sem depender de upsert com chave composta.

export default (sequelize, DataTypes) => {
    const MetaInsightDaily = sequelize.define('MetaInsightDaily', {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },

        entity_level: { type: DataTypes.STRING(10), allowNull: false },  // campaign | adset | ad
        entity_id:    { type: DataTypes.STRING(40), allowNull: false },
        date:         { type: DataTypes.DATEONLY,   allowNull: false },

        // Chaves denormalizadas pra filtrar/rollup sem join (vêm no insight da Meta)
        account_id:  { type: DataTypes.STRING(40) },   // act_xxx
        campaign_id: { type: DataTypes.STRING(40) },
        adset_id:    { type: DataTypes.STRING(40) },

        spend:       { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },
        impressions: { type: DataTypes.INTEGER, defaultValue: 0 },
        clicks:      { type: DataTypes.INTEGER, defaultValue: 0 },
        reach:       { type: DataTypes.INTEGER, defaultValue: 0 },      // não-aditivo entre dias — não somar em totais
        meta_leads:  { type: DataTypes.INTEGER, defaultValue: 0 },
    }, {
        tableName: 'meta_insights_daily',
        underscored: true,
        timestamps: true,
        indexes: [
            // Tabela NOVA: índices declarados aqui são criados junto com a tabela
            // no sync (o problema de índice em alter só afeta tabela existente).
            { unique: true, fields: ['entity_level', 'entity_id', 'date'] },
            { fields: ['entity_level', 'date'] },
            { fields: ['campaign_id', 'date'] },
            { fields: ['account_id'] },
        ],
    });

    return MetaInsightDaily;
};

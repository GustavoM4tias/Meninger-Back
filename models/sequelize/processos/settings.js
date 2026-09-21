// models/sequelize/processos/settings.js
//
// Singleton de configuração do módulo (id = 1).
//
// Regra da casa: o que a operação pode querer mudar nasce em tabela e com
// campo na tela. Aqui isso vale principalmente para o PORTÃO da fila -
// `min_evidencias`, `min_confianca` e `max_por_dia` são o que separa uma fila
// que alguém lê de um badge vermelho que se aprende a ignorar, e o ponto certo
// só a operação descobre usando.
export default (sequelize, DataTypes) => {
    const ProcessoSettings = sequelize.define('ProcessoSettings', {
        id: { type: DataTypes.INTEGER, primaryKey: true, defaultValue: 1 },

        mineracao_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        mineracao_cron: { type: DataTypes.STRING(40), allowNull: false, defaultValue: '0 5 * * *' },

        min_evidencias: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },
        min_confianca: { type: DataTypes.DECIMAL(4, 3), allowNull: false, defaultValue: 0.6 },
        limiar_duplicata: { type: DataTypes.DECIMAL(4, 3), allowNull: false, defaultValue: 0.65 },
        limiar_conflito: { type: DataTypes.DECIMAL(4, 3), allowNull: false, defaultValue: 0.35 },
        max_por_dia: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },

        min_empreendimentos: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
        min_cidades: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 2 },

        promo_min_aprovadas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 10 },
        promo_min_dias: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 14 },
        promo_max_recusadas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },

        retencao_observacao_dias: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 180 },
        notify_user_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'processo_settings',
        underscored: true,
    });

    return ProcessoSettings;
};

// models/sequelize/sienge/envioSiengeWatch.js
//
// Vigia do envio da venda ao ERP: uma pergunta só, uma tabela só (a de regra).
//
// "Quais reservas estão em Envio Sienge há mais de N minutos e ainda não foram
// enviadas ao Sienge?" A resposta é uma consulta ao estado de agora - não há
// histórico nem acompanhamento a manter.

export function defineEnvioSiengeWatchSettings(sequelize, DataTypes) {
    return sequelize.define('EnvioSiengeWatchSettings', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        active: {
            type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false,
            comment: 'Liga o aviso automático. Desligado, a tela continua consultando sob demanda.',
        },

        // 30 min é ~6 rodadas do lote. Medido em 27/08/2026: contando do
        // acionamento do webhook (a entrada na etapa), 226 de 238 vendas foram ao
        // ERP em até 5 minutos, com mediana de 2. Passou de 30, deu erro.
        minutos_limite: {
            type: DataTypes.INTEGER, allowNull: true, defaultValue: 30,
            comment: 'Minutos em Envio Sienge sem envio ao ERP a partir dos quais a venda entra na lista.',
        },

        // Id da etapa é dado do tenant, não constante de código.
        idsituacao_vigiada: {
            type: DataTypes.INTEGER, allowNull: true, defaultValue: 17,
            comment: 'Situação CV que representa a espera pelo envio ao ERP (17 = Envio Sienge).',
        },

        notify_user_ids: {
            type: DataTypes.JSONB, allowNull: false, defaultValue: [],
            comment: 'Quem recebe o aviso. Vazio = ninguém é avisado.',
        },
        cron_expression: {
            type: DataTypes.STRING, allowNull: true, defaultValue: '*/15 * * * *',
            comment: 'De quanto em quanto tempo o vigia olha (cron, fuso de Brasília). Padrão: a cada 15 min.',
        },

        // Ids já avisados, para o aviso não repetir de 15 em 15 minutos enquanto a
        // reserva não é resolvida. Sai da lista quando a venda vai ao ERP.
        avisados_ids: {
            type: DataTypes.JSONB, allowNull: false, defaultValue: [],
            comment: 'Reservas que já geraram aviso nesta pendência. Limpa sozinho quando a venda é enviada.',
        },

        last_run_at: { type: DataTypes.DATE, allowNull: true },
        last_run_resumo: { type: DataTypes.JSONB, allowNull: true },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'envio_sienge_watch_settings',
        underscored: true,
        timestamps: true,
    });
}

export default { defineEnvioSiengeWatchSettings };

// models/sequelize/marketing/mktProjectionSetting.js
//
// Configuração da tela Projeção de Investimentos (Marketing). Linha única.
//
// A fonte da tela é uma planilha do SharePoint mantida pelo Marketing, não o
// banco do Office. Onde ela está, quais abas ignorar e a régua do status
// (atenção/estouro) são decisões da operação: moram aqui e se editam na tela.
// Os defaults em código valem só enquanto ninguém configurou.
export default (sequelize, DataTypes) => {
    const MktProjectionSetting = sequelize.define('MktProjectionSetting', {
        // Link do arquivo no SharePoint, como a pessoa copia do navegador. O
        // Office resolve para drive/item pelo Graph (/shares) e guarda abaixo.
        file_url: { type: DataTypes.TEXT, allowNull: false },
        drive_id: { type: DataTypes.STRING(200), allowNull: true },
        item_id: { type: DataTypes.STRING(200), allowNull: true },
        file_name: { type: DataTypes.STRING(300), allowNull: true },
        file_web_url: { type: DataTypes.TEXT, allowNull: true },

        // Abas que não são empreendimento, separadas por ";".
        ignored_sheets: { type: DataTypes.STRING(500), allowNull: false, defaultValue: 'PLANO DE MÍDIA' },

        // Status = investido desde o lançamento / viabilidade de MKT.
        attention_pct: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 80 },
        overrun_pct: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },

        // Ao abrir a tela, o Office pergunta ao SharePoint se o arquivo mudou.
        // Dentro desta janela ele nem pergunta e serve o que já leu.
        check_interval_seconds: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 60 },

        // Última leitura bem-sucedida (para a tela dizer de quando é o dado).
        last_modified: { type: DataTypes.DATE, allowNull: true },
        last_synced_at: { type: DataTypes.DATE, allowNull: true },
        last_error: { type: DataTypes.TEXT, allowNull: true },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'mkt_projection_settings',
        timestamps: true,
        underscored: true,
    });

    return MktProjectionSetting;
};

// models/sequelize/cv/panelSettings.js
//
// Credencial do painel do CV usada pelas APIs v3 (Bearer/JWT). Tabela
// singleton (sempre id=1), no mesmo espírito de boleto_settings.
//
// Por que no banco e não no .env: o CV FORÇA troca de senha de tempos em
// tempos. Credencial em variável de ambiente significa que, a cada rotação, a
// leitura da associação imobiliária x empreendimento morre e só volta com
// deploy. Aqui um admin corrige pela tela em trinta segundos.
//
// Os campos de saúde existem para a falha ser BARULHENTA. O modo natural de
// essa integração quebrar é o pior possível: ela para de ler e o dado apenas
// envelhece, sem nada na tela dizendo que envelheceu. `last_ok_at` x
// `last_error_at` respondem "isto ainda funciona?", e `alert_sent_at` garante
// que o aviso saia uma vez por episódio, não a cada hora do cron.

export default (sequelize, DataTypes) => {
    const CvPanelSettings = sequelize.define('CvPanelSettings', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        // Credencial da API v1/v2 (chave de integração). Vazio = usa o ambiente,
        // que é como sempre funcionou.
        api_email: { type: DataTypes.STRING(255), comment: 'E-mail da chave de integração v1/v2' },
        api_token: { type: DataTypes.STRING(255), comment: 'Token da chave de integração v1/v2' },

        email: { type: DataTypes.STRING(255), comment: 'E-mail do usuário do painel do CV (v3)' },
        senha: { type: DataTypes.STRING(255), comment: 'Senha desse usuário (o CV rotaciona periodicamente)' },
        painel: { type: DataTypes.STRING(40), defaultValue: 'gestor', comment: 'gestor | corretor | imobiliaria' },

        // Quem é avisado quando a credencial para de funcionar. Vazio = todos
        // os admins, que é o comportamento seguro para não ficar sem ninguém.
        notify_user_ids: {
            type: DataTypes.JSONB,
            defaultValue: [],
            comment: 'IDs de usuários avisados na falha; vazio = todos os admins',
        },

        last_ok_at: { type: DataTypes.DATE, comment: 'Última autenticação bem-sucedida' },
        last_error: { type: DataTypes.TEXT, comment: 'Mensagem da última falha de login' },
        last_error_at: { type: DataTypes.DATE },
        alert_sent_at: { type: DataTypes.DATE, comment: 'Um aviso por episódio; o sucesso limpa' },
    }, {
        tableName: 'cv_panel_settings',
        underscored: true,
    });

    return CvPanelSettings;
};

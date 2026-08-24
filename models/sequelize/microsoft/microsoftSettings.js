// models/sequelize/microsoft/microsoftSettings.js
//
// Configurações da integração Microsoft 365 — singleton (id=1).
//
// Os tetos abaixo eram constantes espalhadas pelos services ($top=500 no
// SharePoint, limit '100mb' na rota de upload). Constante em código é fallback,
// não regra: quem manda é a tela de diagnóstico da integração.
export default (sequelize, DataTypes) => {
    const MicrosoftSettings = sequelize.define('MicrosoftSettings', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        // ── Listagens ────────────────────────────────────────────────────────
        // Teto de itens que uma listagem do Graph pode trazer seguindo o
        // @odata.nextLink. Bateu no teto, a tela DIZ que a lista está cortada —
        // nunca finge que acabou.
        list_page_cap: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 5000,
            comment: 'Máximo de itens por listagem do Graph (paginação segue o nextLink até este teto).',
        },

        // ── Upload para o SharePoint ─────────────────────────────────────────
        upload_max_mb: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 250,
            comment: 'Tamanho máximo de arquivo aceito no upload para o SharePoint, em MB.',
        },
        upload_chunk_mb: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 8,
            comment: 'Tamanho de cada pedaço da sessão de upload, em MB (o Graph exige múltiplo de 320 KiB).',
        },

        // ── Outlook ──────────────────────────────────────────────────────────
        outlook_enabled: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: true,
            comment: 'Liga o módulo de e-mail. Desligado, a tela some e a API responde 503.',
        },
        outlook_send_enabled: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: true,
            comment: 'Permite ENVIAR e-mail pelo Office. Separado da leitura: envio não tem desfazer.',
        },
        outlook_page_size: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 25,
            comment: 'Quantas mensagens a lista traz por vez.',
        },

        // ── Lembrete de reunião ──────────────────────────────────────────────
        meeting_reminder_enabled: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: true,
            comment: 'Avisa antes de a reunião do Teams começar, pelos canais que a pessoa escolheu.',
        },
        meeting_reminder_minutes: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 15,
            comment: 'Quantos minutos antes avisar.',
        },

        // ── Transcrições ─────────────────────────────────────────────────────
        // Com permissão de APLICAÇÃO consentida (OnlineMeetingTranscript.Read.All
        // + política de acesso), o Office consegue a transcrição de reunião que o
        // usuário apenas participou. Sem o consentimento, a tentativa falha e o
        // comportamento é exatamente o de antes.
        transcript_app_fallback: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: true,
            comment: 'Tenta resolver a reunião com token de aplicação quando o delegado não encontra.',
        },

        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'microsoft_settings',
        underscored: true,
        timestamps: true,
    });

    MicrosoftSettings.associate = () => {};
    return MicrosoftSettings;
};

// models/sequelize/meetingTranscript.js
export default (sequelize, DataTypes) => {
    const MeetingTranscript = sequelize.define('MeetingTranscript', {
        // Chave natural anti-duplicata: user_id + transcript_id (index unique abaixo)
        user_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'users', key: 'id' },
        },

        // IDs do Graph API
        meeting_id: {
            type: DataTypes.STRING(500),
            allowNull: false,
            comment: 'onlineMeeting.id do Microsoft Graph',
        },
        transcript_id: {
            type: DataTypes.STRING(500),
            allowNull: false,
            comment: 'ID da transcrição específica no Graph API',
        },

        // Metadados da reunião (copiados para não depender do Graph API depois)
        subject: { type: DataTypes.STRING(500), allowNull: true },
        meeting_date: { type: DataTypes.DATE, allowNull: true },
        duration_min: { type: DataTypes.INTEGER, allowNull: true },
        join_url: { type: DataTypes.TEXT, allowNull: true },
        web_link: { type: DataTypes.TEXT, allowNull: true },
        organizer_name: { type: DataTypes.STRING(255), allowNull: true },
        organizer_email: { type: DataTypes.STRING(255), allowNull: true },
        attendees_json: {
            type: DataTypes.JSON,
            allowNull: true,
            comment: 'Array de {name, email} dos participantes',
        },

        // Conteúdo da transcrição (cache — evita re-download do Graph API)
        parsed_transcript: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'JSON.stringify de [{speaker, startStr, startSec, text}]',
        },
        transcript_char_count: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },

        // Relatório gerado pela IA
        report_json: {
            type: DataTypes.JSON,
            allowNull: true,
            comment: 'Relatório completo gerado pelo Gemini',
        },
        tokens_used: { type: DataTypes.INTEGER, allowNull: true },
        ai_model: { type: DataTypes.STRING(100), allowNull: true },
        report_generated_at: { type: DataTypes.DATE, allowNull: true },

        // Estado do registro
        status: {
            type: DataTypes.ENUM('pending', 'transcribed', 'summarized', 'error'),
            allowNull: false,
            defaultValue: 'pending',
        },
        error_message: { type: DataTypes.TEXT, allowNull: true },
    }, {
        tableName: 'meeting_transcripts',
        underscored: true,
        timestamps: true,
        indexes: [
            // Garante 0 duplicatas: mesma transcrição do mesmo usuário = 1 linha
            { unique: true, fields: ['user_id', 'transcript_id'] },
            { fields: ['user_id', 'meeting_date'] },
            { fields: ['status'] },
        ],
    });

    MeetingTranscript.associate = (models) => {
        MeetingTranscript.belongsTo(models.User, {
            foreignKey: 'user_id',
            as: 'user',
        });
    };

    return MeetingTranscript;
};

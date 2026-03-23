// models/sequelize/inPersonMeeting.js
export default (sequelize, DataTypes) => {
    const InPersonMeeting = sequelize.define('InPersonMeeting', {
        user_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'users', key: 'id' },
        },
        title: {
            type: DataTypes.STRING(500),
            allowNull: false,
        },
        location: {
            type: DataTypes.STRING(500),
            allowNull: true,
        },
        meeting_date: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: 'Data/hora de início da gravação',
        },
        ended_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },
        duration_min: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
        organizer_name: {
            type: DataTypes.STRING(255),
            allowNull: true,
        },
        attendees_json: {
            type: DataTypes.JSON,
            allowNull: true,
            comment: 'Array de {name} dos participantes',
        },

        // Transcrição
        parsed_transcript: {
            type: DataTypes.TEXT('long'),
            allowNull: true,
            comment: 'JSON.stringify de [{speaker, startStr, startSec, text}]',
        },
        transcript_char_count: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },

        // Relatório IA
        report_json: {
            type: DataTypes.JSON,
            allowNull: true,
        },
        tokens_used: { type: DataTypes.INTEGER, allowNull: true },
        ai_model:    { type: DataTypes.STRING(100), allowNull: true },
        report_generated_at: { type: DataTypes.DATE, allowNull: true },

        // Estado
        status: {
            type: DataTypes.ENUM('recording', 'recorded', 'summarized', 'error'),
            allowNull: false,
            defaultValue: 'recording',
        },
        error_message: { type: DataTypes.TEXT, allowNull: true },
    }, {
        tableName: 'in_person_meetings',
        underscored: true,
        timestamps: true,
        indexes: [
            { fields: ['user_id', 'meeting_date'] },
            { fields: ['user_id', 'status'] },
        ],
    });

    InPersonMeeting.associate = (models) => {
        InPersonMeeting.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    };

    return InPersonMeeting;
};

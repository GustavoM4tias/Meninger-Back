// models/sequelize/instantMeeting.js
// Reuniões instantâneas do Teams (POST /me/onlineMeetings) NÃO criam evento de
// calendário, então não aparecem no /me/calendarView. Persistimos aqui para que
// a listagem de Transcrições & IA consiga exibi-las e puxar suas transcrições.
export default (sequelize, DataTypes) => {
    const InstantMeeting = sequelize.define('InstantMeeting', {
        user_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'users', key: 'id' },
        },

        // onlineMeeting.id do Microsoft Graph (mesmo id usado nos endpoints de transcript)
        meeting_id: {
            type: DataTypes.STRING(500),
            allowNull: false,
            comment: 'onlineMeeting.id do Microsoft Graph',
        },

        subject:  { type: DataTypes.STRING(500), allowNull: true },
        join_url: { type: DataTypes.TEXT, allowNull: true },
        start_at: { type: DataTypes.DATE, allowNull: true },
        end_at:   { type: DataTypes.DATE, allowNull: true },

        organizer_name:  { type: DataTypes.STRING(255), allowNull: true },
        organizer_email: { type: DataTypes.STRING(255), allowNull: true },
    }, {
        tableName: 'instant_meetings',
        underscored: true,
        timestamps: true,
        indexes: [
            // Mesma reunião do mesmo usuário = 1 linha
            { unique: true, fields: ['user_id', 'meeting_id'] },
            { fields: ['user_id', 'start_at'] },
        ],
    });

    InstantMeeting.associate = (models) => {
        InstantMeeting.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    };

    return InstantMeeting;
};

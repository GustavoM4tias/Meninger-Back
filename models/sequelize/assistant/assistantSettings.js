// models/sequelize/assistant/assistantSettings.js
//
// Como o assistente cutuca ESTA pessoa. Uma linha por usuário.
//
// Tudo aqui é sobre interrupção, e interrupção é preferência: quem entra às 7h
// não quer o resumo às 9h, e quem já vive no Office não quer o mesmo aviso
// também por e-mail.
export default (sequelize, DataTypes) => {
    const AssistantSettings = sequelize.define('AssistantSettings', {
        user_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'users', key: 'id' },
        },
        ativo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

        resumo_diario: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        resumo_hora: {
            type: DataTypes.SMALLINT, allowNull: false, defaultValue: 8,
            comment: 'Hora do resumo do dia (0-23), no fuso de Brasília.',
        },

        alerta_prazo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        alerta_parado: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        dias_parado: {
            type: DataTypes.SMALLINT, allowNull: false, defaultValue: 3,
            comment: 'Depois de quantos dias uma pendência vira cobrança.',
        },

        // Canais além do sino. E-mail funciona hoje (Mail.Send concedida).
        // Teams depende de o Office estar registrado como app do Teams, o que
        // ainda não aconteceu - o campo existe para quando acontecer.
        por_email: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        por_teams: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

        criar_tarefa_de_email: {
            type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true,
            comment: 'E-mail que a IA marcou como "precisa de você" vira tarefa sozinho.',
        },
    }, {
        tableName: 'assistant_settings',
        underscored: true,
        timestamps: true,
    });

    AssistantSettings.associate = (models) => {
        AssistantSettings.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    };
    return AssistantSettings;
};

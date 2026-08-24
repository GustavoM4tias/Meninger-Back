// models/sequelize/microsoft/microsoftSubscription.js
//
// Assinatura de mudanças do Microsoft Graph (change notifications).
//
// Até aqui tudo era PUXADO: o Office perguntava à Microsoft, sempre com alguém
// na frente da tela. Assinatura inverte — a Microsoft avisa quando algo muda.
//
// Precisa de persistência porque a assinatura vive no lado da Microsoft e expira
// (no máximo ~3 dias para e-mail e calendário). Sem registrar o id e o
// vencimento aqui, o backend não saberia o que renovar nem o que apagar, e cada
// reinício criaria assinatura duplicada — que significa notificação duplicada.
export default (sequelize, DataTypes) => {
    const MicrosoftSubscription = sequelize.define('MicrosoftSubscription', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        // Dono da assinatura. Null = assinatura de nível de aplicação.
        user_id: { type: DataTypes.INTEGER, allowNull: true },

        // Recurso observado, como o Graph o nomeia.
        // Ex.: users/{id}/mailFolders('inbox')/messages
        resource:    { type: DataTypes.STRING(500), allowNull: false },
        change_type: { type: DataTypes.STRING(60),  allowNull: false, defaultValue: 'created' },

        // Id da assinatura NO LADO DA MICROSOFT. É por ele que se renova e apaga.
        subscription_id: { type: DataTypes.STRING(200), allowNull: true, unique: true },

        // Segredo que volta em cada notificação. Notificação sem o clientState
        // certo é descartada — é o que impede alguém de fingir ser a Microsoft
        // chamando o nosso webhook, que é público por obrigação.
        client_state: { type: DataTypes.STRING(128), allowNull: false },

        notification_url: { type: DataTypes.TEXT, allowNull: true },
        expires_at:       { type: DataTypes.DATE, allowNull: true },

        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

        last_notification_at: { type: DataTypes.DATE, allowNull: true },
        notification_count:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        last_error:           { type: DataTypes.TEXT, allowNull: true },
    }, {
        tableName: 'microsoft_subscriptions',
        underscored: true,
        timestamps: true,
        indexes: [
            { fields: ['user_id'] },
            { fields: ['expires_at'] },
        ],
    });

    MicrosoftSubscription.associate = (models) => {
        MicrosoftSubscription.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    };

    return MicrosoftSubscription;
};

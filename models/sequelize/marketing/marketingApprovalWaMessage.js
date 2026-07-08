export default (sequelize, DataTypes) => {
    // Rastreio do template WhatsApp enviado a cada aprovador (padrão alert_shares):
    // o wamid (meta_message_id) casa a resposta do botão com o ticket + usuário.
    const MarketingApprovalWaMessage = sequelize.define('MarketingApprovalWaMessage', {
        request_id: { type: DataTypes.INTEGER, allowNull: false },
        user_id: { type: DataTypes.INTEGER, allowNull: false },
        phone: { type: DataTypes.STRING(30), allowNull: false },
        meta_message_id: { type: DataTypes.STRING(200), allowNull: true, unique: true },
        // sent | answered | expired
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'sent' },
    }, {
        tableName: 'marketing_approval_wa_messages',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['request_id'] },
            { fields: ['user_id'] },
        ],
    });

    MarketingApprovalWaMessage.associate = (db) => {
        MarketingApprovalWaMessage.belongsTo(db.MarketingApprovalRequest, { foreignKey: 'request_id', as: 'request' });
    };

    return MarketingApprovalWaMessage;
};

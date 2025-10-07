export default (sequelize, DataTypes) => {
    const SupportMessage = sequelize.define('SupportMessage', {
        id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
        ticket_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
        author_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
        author_name: { type: DataTypes.STRING(120), allowNull: true },
        author_email: { type: DataTypes.STRING(160), allowNull: true },
        body: { type: DataTypes.TEXT, allowNull: false },           // 👈 sem 'long'
        attachments: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // 👈 JSONB
        origin: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'web' },
    }, {
        tableName: 'support_messages',
        underscored: true,
        timestamps: true,
        indexes: [{ fields: ['ticket_id'] }],
    });

    SupportMessage.associate = (models) => {
        SupportMessage.belongsTo(models.SupportTicket, { as: 'ticket', foreignKey: 'ticket_id' });
        SupportMessage.belongsTo(models.User, { as: 'author', foreignKey: 'author_id' });
    };

    return SupportMessage;
};

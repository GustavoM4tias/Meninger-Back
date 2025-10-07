export default (sequelize, DataTypes) => {
    const SupportTicket = sequelize.define('SupportTicket', {
        id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
        protocol: { type: DataTypes.STRING(20), allowNull: false, unique: true },
        title: { type: DataTypes.STRING(200), allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: false },

        problem_type: { type: DataTypes.STRING(32), allowNull: false },
        priority: { type: DataTypes.STRING(16), allowNull: false },

        module: { type: DataTypes.STRING(64), allowNull: true },

        status: {
            type: DataTypes.ENUM('pending', 'in_progress', 'resolved', 'closed'),
            allowNull: false,
            defaultValue: 'pending',
        },

        browser: { type: DataTypes.STRING(32), allowNull: true },
        os: { type: DataTypes.STRING(32), allowNull: true },
        page_url: { type: DataTypes.TEXT, allowNull: true },

        requester_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
        thread_token: { type: DataTypes.STRING(64), allowNull: false },
    }, {
        tableName: 'support_tickets',
        underscored: true,
        timestamps: true,
        indexes: [
            { fields: ['status'] },
            { fields: ['requester_id'] },
            { unique: true, fields: ['protocol'] },
        ],
    });

    SupportTicket.associate = (models) => {
        SupportTicket.belongsTo(models.User, { as: 'requester', foreignKey: 'requester_id' });
        SupportTicket.hasMany(models.SupportMessage, { as: 'messages', foreignKey: 'ticket_id', onDelete: 'CASCADE' });
    };

    return SupportTicket;
};

export default (sequelize, DataTypes) => {
    // Decisão de UM perfil sobre um ticket (unique request+profile). O status do
    // ticket é derivado destas linhas: rejected em qualquer reprovação; aprovado
    // quando todos os auth_profile_ids do ticket tiverem decisão.
    const MarketingApprovalDecision = sequelize.define('MarketingApprovalDecision', {
        request_id: { type: DataTypes.INTEGER, allowNull: false },
        profile_id: { type: DataTypes.INTEGER, allowNull: false },
        user_id: { type: DataTypes.INTEGER, allowNull: false },
        // approved | approved_with_notes | rejected
        decision: { type: DataTypes.STRING(30), allowNull: false },
        // Obrigatório p/ approved_with_notes (a ressalva) e rejected (a justificativa).
        comment: { type: DataTypes.TEXT, allowNull: true },
        // office | whatsapp
        via: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'office' },
    }, {
        tableName: 'marketing_approval_decisions',
        timestamps: true,
        underscored: true,
        indexes: [
            { unique: true, fields: ['request_id', 'profile_id'] },
            { fields: ['user_id'] },
        ],
    });

    MarketingApprovalDecision.associate = (db) => {
        MarketingApprovalDecision.belongsTo(db.MarketingApprovalRequest, { foreignKey: 'request_id', as: 'request' });
        MarketingApprovalDecision.belongsTo(db.MarketingApprovalAuthProfile, { foreignKey: 'profile_id', as: 'profile', constraints: false });
        if (db.User) MarketingApprovalDecision.belongsTo(db.User, { foreignKey: 'user_id', as: 'user', constraints: false });
    };

    return MarketingApprovalDecision;
};

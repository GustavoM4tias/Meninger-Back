export default (sequelize, DataTypes) => {
    // Anexo do ticket (orçamentos, artes, propostas) — Supabase, mesmo padrão do checklist.
    const MarketingApprovalAttachment = sequelize.define('MarketingApprovalAttachment', {
        request_id: { type: DataTypes.INTEGER, allowNull: false },
        file_name: { type: DataTypes.STRING(300), allowNull: false },
        mime_type: { type: DataTypes.STRING(120), allowNull: true },
        url: { type: DataTypes.TEXT, allowNull: false },
        storage_path: { type: DataTypes.TEXT, allowNull: true },
        size: { type: DataTypes.BIGINT, allowNull: true },
        // FILE | IMAGE | SIGNED_DOCUMENT (documento de autorização assinado fora do sistema)
        kind: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'FILE' },
        uploaded_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'marketing_approval_attachments',
        timestamps: true,
        underscored: true,
        indexes: [{ fields: ['request_id'] }],
    });

    MarketingApprovalAttachment.associate = (db) => {
        MarketingApprovalAttachment.belongsTo(db.MarketingApprovalRequest, { foreignKey: 'request_id', as: 'request' });
    };

    return MarketingApprovalAttachment;
};

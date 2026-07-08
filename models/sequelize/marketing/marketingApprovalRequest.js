export default (sequelize, DataTypes) => {
    // Ticket de aprovação do Marketing p/ diretoria. Protocolo legível MKT-ANO-SEQ
    // (unique composto year+seq, geração MAX+1 em transação com retry).
    // Centro de custo = cdempreendview do Sienge (opcional, p/ futura ponte financeira).
    // Status derivado das decisões por perfil (marketing_approval_decisions):
    // qualquer reprovação encerra; aprovado quando todos os perfis decidirem.
    const MarketingApprovalRequest = sequelize.define('MarketingApprovalRequest', {
        protocol: { type: DataTypes.STRING(20), allowNull: false, unique: true },
        protocol_year: { type: DataTypes.INTEGER, allowNull: false },
        protocol_seq: { type: DataTypes.INTEGER, allowNull: false },
        requester_id: { type: DataTypes.INTEGER, allowNull: false },
        // Snapshot do catálogo de tipos (settings.types) na criação.
        type_key: { type: DataTypes.STRING(60), allowNull: false },
        type_label: { type: DataTypes.STRING(120), allowNull: false },
        // cdempreendview do Sienge (ecadempreend); nome é snapshot p/ exibição offline.
        cost_center_id: { type: DataTypes.INTEGER, allowNull: true },
        cost_center_name: { type: DataTypes.STRING(200), allowNull: true },
        description: { type: DataTypes.TEXT, allowNull: false },
        justification: { type: DataTypes.TEXT, allowNull: true },
        // Itens da ficha: [{ name, description, amount }]. Uma ficha pode ter
        // vários itens (várias aprovações numa só). amount abaixo = soma deles.
        items: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
        supplier: { type: DataTypes.STRING(200), allowNull: true },
        due_date: { type: DataTypes.DATEONLY, allowNull: true },
        // [profileId, ...] — perfis que precisam autorizar (mínimo 1).
        auth_profile_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        // pending | approved | approved_with_notes | rejected | cancelled
        status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'pending' },
        finalized_at: { type: DataTypes.DATE, allowNull: true },
        cancelled_at: { type: DataTypes.DATE, allowNull: true },
        // [{ action, user_id, username, profile_id?, at, note }]
        approval_history: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    }, {
        tableName: 'marketing_approval_requests',
        timestamps: true,
        underscored: true,
        indexes: [
            { unique: true, fields: ['protocol_year', 'protocol_seq'] },
            { fields: ['status'] },
            { fields: ['requester_id'] },
            { fields: ['type_key'] },
        ],
    });

    MarketingApprovalRequest.associate = (db) => {
        if (db.User) MarketingApprovalRequest.belongsTo(db.User, { foreignKey: 'requester_id', as: 'requester', constraints: false });
        MarketingApprovalRequest.hasMany(db.MarketingApprovalDecision, { foreignKey: 'request_id', as: 'decisions', onDelete: 'CASCADE' });
        MarketingApprovalRequest.hasMany(db.MarketingApprovalAttachment, { foreignKey: 'request_id', as: 'attachments', onDelete: 'CASCADE' });
    };

    return MarketingApprovalRequest;
};

export default (sequelize, DataTypes) => {
    // Perfil de autorização das Aprovações de Marketing (ex.: Diretoria, Financeiro).
    // Mesmo padrão do ChecklistAuthProfile: membros via JSONB user_ids, só admin gerencia.
    // Cada perfil selecionado num ticket dá UMA decisão (qualquer membro decide por ele).
    const MarketingApprovalAuthProfile = sequelize.define('MarketingApprovalAuthProfile', {
        name: { type: DataTypes.STRING(120), allowNull: false },
        description: { type: DataTypes.STRING(300), allowNull: true },
        // [userId, ...] — membros que podem decidir em nome deste perfil.
        user_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        created_by: { type: DataTypes.INTEGER, allowNull: true },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'marketing_approval_auth_profiles',
        timestamps: true,
        underscored: true,
    });

    return MarketingApprovalAuthProfile;
};

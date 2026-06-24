export default (sequelize, DataTypes) => {
    // Perfil de autorização (ex.: Marketing, Comercial). Membros via JSONB user_ids
    // (mesmo padrão de key_dates). Só admin gerencia. Usado p/ exigir aprovação de tarefas.
    const ChecklistAuthProfile = sequelize.define('ChecklistAuthProfile', {
        name: { type: DataTypes.STRING(120), allowNull: false },
        description: { type: DataTypes.STRING(300), allowNull: true },
        // [userId, ...] — membros que precisam aprovar em nome deste perfil.
        user_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        created_by: { type: DataTypes.INTEGER, allowNull: true },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'checklist_auth_profiles',
        timestamps: true,
        underscored: true,
    });

    return ChecklistAuthProfile;
};

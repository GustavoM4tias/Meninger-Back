export default (sequelize, DataTypes) => {
    const AcademyOnboardingRule = sequelize.define('AcademyOnboardingRule', {
        // Quando aplicar: ROLE | POSITION | DEPARTMENT | CITY | ALL
        // ALL → todo novo user (ex: trilha "Boas-vindas Menin")
        scopeType: { type: DataTypes.STRING(20), allowNull: false },
        scopeValue: { type: DataTypes.STRING, allowNull: true }, // null se scopeType=ALL

        // Trilha alvo a ser atribuída
        trackSlug: { type: DataTypes.STRING, allowNull: false },

        // Se vira mandatory + dueAt = createdAt + dueDays
        mandatory: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        dueDays: { type: DataTypes.INTEGER, allowNull: true },

        // Ativo / pausado
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    }, {
        tableName: 'academy_onboarding_rules',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['active'] },
            { fields: ['scope_type', 'scope_value'] },
            { fields: ['track_slug'] },
        ],
    });

    return AcademyOnboardingRule;
};

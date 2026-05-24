export default (sequelize, DataTypes) => {
    const AcademyUserXp = sequelize.define('AcademyUserXp', {
        userId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
        totalXp: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        // level é derivado de totalXp mas guardamos para queries rápidas + histórico
        level: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },

        // Streak diário: dias consecutivos com ATIVIDADE (any awardXp).
        currentStreak: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        longestStreak: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        lastActivityAt: { type: DataTypes.DATE, allowNull: true },
    }, {
        tableName: 'academy_user_xp',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['user_id'], unique: true, name: 'academy_user_xp_user_id_unique' },
            { fields: ['total_xp'] },
            { fields: ['level'] },
        ],
    });

    AcademyUserXp.associate = (db) => {
        if (db.User) {
            AcademyUserXp.belongsTo(db.User, { foreignKey: 'userId', as: 'user' });
        }
    };

    return AcademyUserXp;
};

export default (sequelize, DataTypes) => {
    const AcademyUserBadge = sequelize.define('AcademyUserBadge', {
        userId: { type: DataTypes.INTEGER, allowNull: false },
        badgeSlug: { type: DataTypes.STRING(60), allowNull: false },
        awardedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    }, {
        tableName: 'academy_user_badges',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['user_id'] },
            { fields: ['badge_slug'] },
            { unique: true, fields: ['user_id', 'badge_slug'], name: 'academy_user_badges_user_badge_unique' },
        ],
    });

    AcademyUserBadge.associate = (db) => {
        AcademyUserBadge.belongsTo(db.AcademyBadge, { foreignKey: 'badgeSlug', targetKey: 'slug', as: 'badge', constraints: false });
        if (db.User) {
            AcademyUserBadge.belongsTo(db.User, { foreignKey: 'userId', as: 'user' });
        }
    };

    return AcademyUserBadge;
};

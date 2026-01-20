export default (sequelize, DataTypes) => {
    const AcademyUserProgress = sequelize.define('AcademyUserProgress', {
        userId: { type: DataTypes.INTEGER, allowNull: false },
        trackSlug: { type: DataTypes.STRING, allowNull: false },
        itemId: { type: DataTypes.INTEGER, allowNull: false },

        completed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        completedAt: { type: DataTypes.DATE, allowNull: true },
    }, {
        tableName: 'academy_user_progress',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['user_id', 'track_slug'] },
            { fields: ['item_id'] },
        ],
    });

    return AcademyUserProgress;
};

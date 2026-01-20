export default (sequelize, DataTypes) => {
    const AcademyUserTrackProgress = sequelize.define('AcademyUserTrackProgress', {
        userId: { type: DataTypes.INTEGER, allowNull: false },

        trackSlug: { type: DataTypes.STRING, allowNull: false },

        // IN_PROGRESS | COMPLETED
        status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'IN_PROGRESS' },

        progressPercent: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    }, {
        tableName: 'academy_user_track_progress',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['user_id'] },
            { fields: ['track_slug'] },
            { fields: ['status'] },
        ],
    });

    return AcademyUserTrackProgress;
};

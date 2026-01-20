export default (sequelize, DataTypes) => {
    const AcademyTrackAssignment = sequelize.define('AcademyTrackAssignment', {
        trackSlug: { type: DataTypes.STRING, allowNull: false },
        scopeType: { type: DataTypes.STRING, allowNull: false }, // ROLE | POSITION | CITY | USER
        scopeValue: { type: DataTypes.STRING, allowNull: false }, // ex: "admin", "3" (positionId), "2" (cityId), "15" (userId)
        required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    }, {
        tableName: 'academy_track_assignments',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['track_slug'] },
            { fields: ['scope_type', 'scope_value'] },
            { unique: true, fields: ['track_slug', 'scope_type', 'scope_value'] },
        ],
    });

    AcademyTrackAssignment.associate = (db) => {
        // Relaciona por slug (sem FK forte), suficiente pra queries e limpeza.
        AcademyTrackAssignment.belongsTo(db.AcademyTrack, {
            foreignKey: 'trackSlug',
            targetKey: 'slug',
            as: 'track',
            constraints: false,
        });
    };

    return AcademyTrackAssignment;
};

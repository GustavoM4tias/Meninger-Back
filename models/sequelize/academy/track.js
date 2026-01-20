export default (sequelize, DataTypes) => {
    const AcademyTrack = sequelize.define('AcademyTrack', {
        slug: { type: DataTypes.STRING, allowNull: false, unique: true },
        title: { type: DataTypes.STRING, allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
        audience: { type: DataTypes.STRING, allowNull: false, defaultValue: 'BOTH' }, // BOTH | GESTOR_ONLY | ADM_ONLY
        status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'PUBLISHED' }, // DRAFT | PUBLISHED
    }, {
        tableName: 'academy_tracks',
        timestamps: true,
        underscored: true,
    });

    AcademyTrack.associate = (db) => {
        AcademyTrack.hasMany(db.AcademyTrackItem, { foreignKey: 'trackId', as: 'items' });
    };

    return AcademyTrack;
};

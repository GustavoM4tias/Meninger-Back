export default (sequelize, DataTypes) => {
    const AcademyModule = sequelize.define('AcademyModule', {
        trackId: { type: DataTypes.INTEGER, allowNull: false },
        orderIndex: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
        title: { type: DataTypes.STRING, allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
    }, {
        tableName: 'academy_modules',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['track_id'] },
            { fields: ['track_id', 'order_index'] },
        ],
    });

    AcademyModule.associate = (db) => {
        AcademyModule.belongsTo(db.AcademyTrack, { foreignKey: 'trackId', as: 'track' });
        AcademyModule.hasMany(db.AcademyTrackItem, { foreignKey: 'moduleId', as: 'items' });
    };

    return AcademyModule;
};

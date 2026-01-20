export default (sequelize, DataTypes) => {
    const AcademyTrackItem = sequelize.define('AcademyTrackItem', {
        trackId: { type: DataTypes.INTEGER, allowNull: false },

        orderIndex: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },

        // TEXT | VIDEO | QUIZ | ARTICLE | COMMUNITY_TOPIC | LINK | TASK | FORM
        type: { type: DataTypes.STRING, allowNull: false, defaultValue: 'TASK' },

        title: { type: DataTypes.STRING, allowNull: false },

        // URL / kb://cat/article / topic://123 / etc.
        target: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },

        // texto markdown p/ TEXT e complementos
        content: { type: DataTypes.TEXT, allowNull: true },

        // QUIZ e configs por tipo
        payload: { type: DataTypes.JSONB, allowNull: true },

        estimatedMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    }, {
        tableName: 'academy_track_items',
        timestamps: true,
        underscored: true,
        indexes: [{ fields: ['track_id'] }, { fields: ['order_index'] }],
    });

    AcademyTrackItem.associate = (db) => {
        AcademyTrackItem.belongsTo(db.AcademyTrack, { foreignKey: 'trackId', as: 'track' });
    };

    return AcademyTrackItem;
};

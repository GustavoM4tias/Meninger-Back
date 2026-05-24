export default (sequelize, DataTypes) => {
    const AcademyVideoWatch = sequelize.define('AcademyVideoWatch', {
        userId: { type: DataTypes.INTEGER, allowNull: false },
        itemId: { type: DataTypes.INTEGER, allowNull: false },
        trackSlug: { type: DataTypes.STRING, allowNull: false },

        // Última posição assistida (segundos).
        currentSec: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

        // Duração total declarada pelo cliente (segundos).
        durationSec: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

        // Maior % atingido (não regride se o aluno volta no vídeo).
        watchedPercent: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

        // Quando atingiu watchedPercent >= AUTO_COMPLETE_THRESHOLD (default 85%).
        autoCompletedAt: { type: DataTypes.DATE, allowNull: true },

        lastWatchedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    }, {
        tableName: 'academy_video_watches',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['user_id'] },
            { fields: ['item_id'] },
            { unique: true, fields: ['user_id', 'item_id'], name: 'academy_video_watches_user_item_unique' },
        ],
    });

    return AcademyVideoWatch;
};

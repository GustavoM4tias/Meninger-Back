export default (sequelize, DataTypes) => {
    const AcademyUserProgress = sequelize.define('AcademyUserProgress', {
        userId: { type: DataTypes.INTEGER, allowNull: false },
        trackSlug: { type: DataTypes.STRING, allowNull: false },
        itemId: { type: DataTypes.INTEGER, allowNull: false },

        completed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        completedAt: { type: DataTypes.DATE, allowNull: true },

        // S3.4: timestamp da primeira vez que o aluno ABRIU o item (ainda
        // sem concluir). Permite calcular tempo médio (openedAt → completedAt)
        // e drop-off (abriu mas nunca concluiu).
        openedAt: { type: DataTypes.DATE, allowNull: true },

        // Evidência forense (S1.6) — capturada no momento da marcação.
        ip: { type: DataTypes.STRING(64), allowNull: true },
        userAgent: { type: DataTypes.TEXT, allowNull: true },
    }, {
        tableName: 'academy_user_progress',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['user_id', 'track_slug'] },
            { fields: ['item_id'] },
            {
                unique: true,
                fields: ['user_id', 'track_slug', 'item_id'],
                name: 'academy_user_progress_user_track_item_unique',
            },
        ],
    });

    return AcademyUserProgress;
};

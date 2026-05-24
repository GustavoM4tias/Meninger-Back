export default (sequelize, DataTypes) => {
    const AcademyTrackPrerequisite = sequelize.define('AcademyTrackPrerequisite', {
        // Trilha que TEM o pré-requisito.
        trackSlug: { type: DataTypes.STRING, allowNull: false },
        // Trilha que precisa estar concluída ANTES.
        requiredTrackSlug: { type: DataTypes.STRING, allowNull: false },
        // Política: STRICT (precisa estar 100% concluída) | LENIENT (precisa só ter começado)
        policy: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'STRICT' },
    }, {
        tableName: 'academy_track_prerequisites',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['track_slug'] },
            { fields: ['required_track_slug'] },
            {
                unique: true,
                fields: ['track_slug', 'required_track_slug'],
                name: 'academy_track_prerequisites_pair_unique',
            },
        ],
    });

    return AcademyTrackPrerequisite;
};

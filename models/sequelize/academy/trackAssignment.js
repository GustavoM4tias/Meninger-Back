export default (sequelize, DataTypes) => {
    const AcademyTrackAssignment = sequelize.define('AcademyTrackAssignment', {
        trackSlug: { type: DataTypes.STRING, allowNull: false },
        scopeType: { type: DataTypes.STRING, allowNull: false }, // ROLE | POSITION | DEPARTMENT | CITY | USER
        scopeValue: { type: DataTypes.STRING, allowNull: false }, // ex: "admin", "3" (positionId), "2" (cityId), "15" (userId)
        required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

        // Compliance (S1.4): trilha "obrigatória" tem deadline de conclusão.
        // - mandatory=true: aluno DEVE concluir até dueAt (recebe lembrete + entra no dashboard de aderência).
        // - mandatory=false: trilha "recomendada" — aparece, mas sem cobrança.
        mandatory: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        dueAt: { type: DataTypes.DATE, allowNull: true },
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

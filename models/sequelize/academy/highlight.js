export default (sequelize, DataTypes) => {
    const AcademyHighlight = sequelize.define('AcademyHighlight', {
        title: { type: DataTypes.STRING, allowNull: false },

        // LINK | ARTICLE | TOPIC | TRACK
        type: { type: DataTypes.STRING, allowNull: false, defaultValue: 'LINK' },

        // exemplo:
        // LINK: "https://..."
        // ARTICLE: "kb/processos/fechamento"
        // TOPIC: "123"
        // TRACK: "gestao-comercial"
        target: { type: DataTypes.STRING, allowNull: false },

        audience: { type: DataTypes.STRING, allowNull: false, defaultValue: 'BOTH' },

        priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 10 },

        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    }, {
        tableName: 'academy_highlights',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['audience'] },
            { fields: ['active'] },
            { fields: ['priority'] },
        ],
    });

    return AcademyHighlight;
};

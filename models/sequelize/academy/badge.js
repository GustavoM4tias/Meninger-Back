export default (sequelize, DataTypes) => {
    const AcademyBadge = sequelize.define('AcademyBadge', {
        slug: { type: DataTypes.STRING(60), allowNull: false, unique: true },
        title: { type: DataTypes.STRING, allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },

        // Emoji ou ícone (lucide name). Aceita também URL externa de PNG.
        icon: { type: DataTypes.STRING, allowNull: true },

        // Regra de concessão (avaliada por badgeEngine):
        //   { kind: 'TRACK_COMPLETED', count: 1 }
        //   { kind: 'TRACKS_COMPLETED', count: 5 }
        //   { kind: 'QUIZ_PASSED', count: 10 }
        //   { kind: 'ARTICLE_PUBLISHED', count: 1 }
        //   { kind: 'TOPIC_CREATED', count: 1 }
        //   { kind: 'STREAK_DAYS', count: 7 }
        //   { kind: 'XP_TOTAL', count: 1000 }
        //   { kind: 'UPVOTES_RECEIVED', count: 10 }
        rule: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },

        // Raridade: COMMON | RARE | EPIC | LEGENDARY (afeta cor/efeito visual no front)
        rarity: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'COMMON' },

        // ACTIVE | ARCHIVED
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ACTIVE' },
    }, {
        tableName: 'academy_badges',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['slug'], unique: true },
            { fields: ['status'] },
        ],
    });

    return AcademyBadge;
};

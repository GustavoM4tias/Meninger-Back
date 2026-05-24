export default (sequelize, DataTypes) => {
    const AcademyCertificate = sequelize.define('AcademyCertificate', {
        userId: { type: DataTypes.INTEGER, allowNull: false },
        trackSlug: { type: DataTypes.STRING, allowNull: false },

        // Código público de verificação (URL-safe, ~22 chars).
        // Não é o id porque o id vaza ordem de emissão. Esse vai no PDF/QR.
        code: { type: DataTypes.STRING(32), allowNull: false, unique: true },

        // Snapshot do título da trilha no momento da emissão (caso o admin renomeie depois).
        trackTitle: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },

        // Snapshot do nome do aluno no momento da emissão.
        userName: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },

        issuedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },

        // Validade opcional — para trilhas com recertificação (Ex: LGPD válido por 12 meses).
        expiresAt: { type: DataTypes.DATE, allowNull: true },

        // Status: ACTIVE | REVOKED | EXPIRED. EXPIRED é calculado on-read se expiresAt < now.
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ACTIVE' },

        revokedAt: { type: DataTypes.DATE, allowNull: true },
        revokedByUserId: { type: DataTypes.INTEGER, allowNull: true },
        revokedReason: { type: DataTypes.STRING, allowNull: true },

        // Evidência forense de conclusão (S1.6): IP, user-agent, timestamp dos items concluídos.
        // Estrutura: {
        //   completedAt: ISO string,
        //   ip: string,
        //   userAgent: string,
        //   items: [{ itemId, completedAt, ip, userAgent }],
        //   quizzes: [{ itemId, allCorrect, correctCount, totalQuestions, submittedAt }]
        // }
        evidence: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    }, {
        tableName: 'academy_certificates',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['user_id'] },
            { fields: ['track_slug'] },
            { fields: ['code'], unique: true },
            { fields: ['status'] },
            // Não unique em (user_id, track_slug) porque pode haver recertificação:
            // mesmo aluno, mesma trilha, novo certificado quando o antigo expira.
        ],
    });

    AcademyCertificate.associate = (db) => {
        if (db.User) {
            AcademyCertificate.belongsTo(db.User, { foreignKey: 'userId', as: 'user' });
            AcademyCertificate.belongsTo(db.User, { foreignKey: 'revokedByUserId', as: 'revokedBy' });
        }
    };

    return AcademyCertificate;
};

export default (sequelize, DataTypes) => {
    const EmeAuditLog = sequelize.define('EmeAuditLog', {
        userId: { type: DataTypes.INTEGER, allowNull: true },
        sessionId: { type: DataTypes.INTEGER, allowNull: true },
        messageId: { type: DataTypes.INTEGER, allowNull: true },

        // ACADEMY | OFFICE
        context: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'OFFICE' },

        // Nome da tool invocada (ex: 'query_leads')
        toolName: { type: DataTypes.STRING(80), allowNull: false },

        // Argumentos brutos passados pelo modelo (após sanitização)
        argsJson: { type: DataTypes.JSONB, allowNull: true },

        // Permission name exigida (se houver)
        requiredPermission: { type: DataTypes.STRING(120), allowNull: true },
        permissionGranted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

        // Filtros aplicados pelo runner (city, role, audience) — para auditoria
        filtersApplied: { type: DataTypes.JSONB, allowNull: true },

        // Quantos resultados foram retornados (para detectar query gigante)
        resultCount: { type: DataTypes.INTEGER, allowNull: true },

        // IDs específicos retornados (limitar a primeiros 100 — só para tracing)
        resultIds: { type: DataTypes.JSONB, allowNull: true },

        // Duração em ms
        ms: { type: DataTypes.INTEGER, allowNull: true },

        // Erro (se houver). null = sucesso.
        error: { type: DataTypes.TEXT, allowNull: true },

        // IP e user-agent (forense)
        ip: { type: DataTypes.STRING(64), allowNull: true },
        userAgent: { type: DataTypes.TEXT, allowNull: true },
    }, {
        tableName: 'eme_audit_logs',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['user_id'] },
            { fields: ['context'] },
            { fields: ['tool_name'] },
            { fields: ['created_at'] },
            { fields: ['user_id', 'created_at'] },
            { fields: ['permission_granted'] },
        ],
    });

    EmeAuditLog.associate = (db) => {
        if (db.User) EmeAuditLog.belongsTo(db.User, { foreignKey: 'userId', as: 'user' });
    };

    return EmeAuditLog;
};

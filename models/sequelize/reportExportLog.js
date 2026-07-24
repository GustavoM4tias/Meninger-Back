// Log de exportações de relatório — trilha de auditoria de quem exportou o quê
// e quando. Só admin consulta. Nome e e-mail são gravados como SNAPSHOT (além
// do userId) para a trilha continuar legível se o usuário for renomeado ou
// removido depois.
export default (sequelize, DataTypes) => {
    const ReportExportLog = sequelize.define('ReportExportLog', {
        userId: { type: DataTypes.INTEGER, allowNull: true },
        userName: { type: DataTypes.STRING(160), allowNull: true },
        userEmail: { type: DataTypes.STRING(160), allowNull: true },

        // Qual relatório (hoje só 'leads', mas já nasce preparado p/ outros)
        report: { type: DataTypes.STRING(60), allowNull: false, defaultValue: 'leads' },

        // pdf | html | excel
        format: { type: DataTypes.STRING(10), allowNull: false },

        // Período do relatório exportado
        periodStart: { type: DataTypes.DATEONLY, allowNull: true },
        periodEnd: { type: DataTypes.DATEONLY, allowNull: true },

        // Quantos registros saíram no arquivo
        recordCount: { type: DataTypes.INTEGER, allowNull: true },

        // Filtros aplicados no momento da exportação (para saber o recorte)
        filtersJson: { type: DataTypes.JSONB, allowNull: true },

        // Forense
        ip: { type: DataTypes.STRING(64), allowNull: true },
        userAgent: { type: DataTypes.TEXT, allowNull: true },
    }, {
        tableName: 'report_export_logs',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['user_id'] },
            { fields: ['report'] },
            { fields: ['format'] },
            { fields: ['created_at'] },
        ],
    });

    ReportExportLog.associate = (db) => {
        if (db.User) ReportExportLog.belongsTo(db.User, { foreignKey: 'userId', as: 'user' });
    };

    return ReportExportLog;
};

// Estado dos jobs de sincronização CV (sobrevive a restarts).
// 1 linha por job (job_name).
export default (sequelize, DataTypes) => {
    const CvSyncState = sequelize.define('CvSyncState', {
        job_name:     { type: DataTypes.STRING(64), primaryKey: true },
        last_run_at:  { type: DataTypes.DATE, allowNull: true },
        last_status:  { type: DataTypes.STRING(16), allowNull: true }, // 'ok' | 'error' | 'running'
        last_message: { type: DataTypes.TEXT, allowNull: true },
        last_stats:   { type: DataTypes.JSONB, allowNull: true },
    }, {
        tableName: 'cv_sync_state',
        underscored: true,
        timestamps: true,
    });

    return CvSyncState;
};

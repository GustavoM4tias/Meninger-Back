// models/sequelize/sienge/backupLog.js
export default (sequelize, DataTypes) => {
  const SiengeBackupLog = sequelize.define('SiengeBackupLog', {
    id:                    { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    started_at:            { type: DataTypes.DATE, allowNull: false },
    finished_at:           { type: DataTypes.DATE, allowNull: true },
    status:                { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'running' },
    stage:                 { type: DataTypes.STRING(50), allowNull: true },
    file_name:             { type: DataTypes.STRING(255), allowNull: true },
    file_size_bytes:       { type: DataTypes.BIGINT, allowNull: true },
    md5_expected:          { type: DataTypes.STRING(64), allowNull: true },
    md5_actual:            { type: DataTypes.STRING(64), allowNull: true },
    bucket_object:         { type: DataTypes.STRING(255), allowNull: true },
    duration_ms:           { type: DataTypes.INTEGER, allowNull: true },
    error_message:         { type: DataTypes.TEXT, allowNull: true },
    triggered_by:          { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'cron' },
    // Fase 2 - import no Oracle Autonomous DB
    import_status:         { type: DataTypes.STRING(20), allowNull: true },  // pending|running|success|failed|skipped
    import_job_name:       { type: DataTypes.STRING(60), allowNull: true },
    import_started_at:     { type: DataTypes.DATE, allowNull: true },
    import_finished_at:    { type: DataTypes.DATE, allowNull: true },
    import_duration_ms:    { type: DataTypes.INTEGER, allowNull: true },
    import_error_message:  { type: DataTypes.TEXT, allowNull: true },
    cleaned_objects_count: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    tableName: 'sienge_backup_logs',
    underscored: true,
    timestamps: true,
  });

  return SiengeBackupLog;
};

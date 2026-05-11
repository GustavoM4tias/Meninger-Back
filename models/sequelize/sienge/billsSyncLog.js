// models/sequelize/sienge/billsSyncLog.js
export default (sequelize, DataTypes) => {
  const BillsSyncLog = sequelize.define('BillsSyncLog', {
    id:                  { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    enterprise_city_id:  { type: DataTypes.BIGINT, allowNull: true },
    cost_center_id:      { type: DataTypes.INTEGER, allowNull: false },
    // 'default' | 'bootstrap' | 'manual'
    mode:                { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'default' },
    started_at:          { type: DataTypes.DATE, allowNull: false },
    finished_at:         { type: DataTypes.DATE, allowNull: true },
    // 'running' | 'success' | 'error'
    status:              { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'running' },
    total_bills:         { type: DataTypes.INTEGER, allowNull: true },
    new_bills:           { type: DataTypes.INTEGER, allowNull: true },
    updated_bills:       { type: DataTypes.INTEGER, allowNull: true },
    installments_synced: { type: DataTypes.INTEGER, allowNull: true },
    expenses_updated:    { type: DataTypes.INTEGER, allowNull: true },
    duration_ms:         { type: DataTypes.INTEGER, allowNull: true },
    error_message:       { type: DataTypes.TEXT, allowNull: true },
    // 'cron' | 'manual'
    triggered_by:        { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'cron' },
  }, {
    tableName: 'bills_sync_logs',
    underscored: true,
    timestamps: true,
  });

  return BillsSyncLog;
};

// models/sequelize/sienge/billsAutoSyncSubscription.js
//
// Marca empreendimentos que devem ser incluídos no auto-sync diário do cron.
// Presença = inscrito. Ausência = só sincroniza manualmente.

export default (sequelize, DataTypes) => {
  const BillsAutoSyncSubscription = sequelize.define('BillsAutoSyncSubscription', {
    enterprise_city_id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      allowNull: false,
    },
    enabled_by: { type: DataTypes.STRING(120), allowNull: true },
    enabled_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'bills_auto_sync_subscriptions',
    underscored: true,
    timestamps: true,
  });

  return BillsAutoSyncSubscription;
};

'use strict';

/**
 * Log de execuções do auto-sync de bills.
 * Um registro por empreendimento por execução.
 *
 * mode:
 *   - 'default'    : sync diário, todos os empreendimentos, janela ano-anterior → futuro
 *   - 'bootstrap'  : carga inicial histórica, 1 empreendimento por vez
 *   - 'manual'     : disparo manual via endpoint admin
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('bills_sync_logs', {
      id:                   { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      enterprise_city_id:   { type: Sequelize.BIGINT, allowNull: true },
      cost_center_id:       { type: Sequelize.INTEGER, allowNull: false },
      mode:                 { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'default' },
      started_at:           { type: Sequelize.DATE, allowNull: false },
      finished_at:          { type: Sequelize.DATE, allowNull: true },
      status:               { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'running' },
      total_bills:          { type: Sequelize.INTEGER, allowNull: true },
      new_bills:            { type: Sequelize.INTEGER, allowNull: true },
      updated_bills:        { type: Sequelize.INTEGER, allowNull: true },
      installments_synced:  { type: Sequelize.INTEGER, allowNull: true },
      expenses_updated:     { type: Sequelize.INTEGER, allowNull: true },
      duration_ms:          { type: Sequelize.INTEGER, allowNull: true },
      error_message:        { type: Sequelize.TEXT, allowNull: true },
      triggered_by:         { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'cron' },
      created_at:           { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at:           { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });

    await queryInterface.addIndex('bills_sync_logs', ['cost_center_id']);
    await queryInterface.addIndex('bills_sync_logs', ['enterprise_city_id']);
    await queryInterface.addIndex('bills_sync_logs', ['started_at']);
    await queryInterface.addIndex('bills_sync_logs', ['status']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('bills_sync_logs');
  },
};

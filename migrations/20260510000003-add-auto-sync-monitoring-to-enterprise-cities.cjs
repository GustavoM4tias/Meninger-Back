'use strict';

/**
 * Colunas de monitoramento do auto-sync de bills por empreendimento.
 * Não há toggle de habilitação — todo enterprise_city com erp_id IS NOT NULL é sincronizado.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('enterprise_cities', 'auto_sync_last_run_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    await queryInterface.addColumn('enterprise_cities', 'auto_sync_last_status', {
      type: Sequelize.STRING(20),
      allowNull: true,
    });

    await queryInterface.addColumn('enterprise_cities', 'auto_sync_last_summary', {
      type: Sequelize.JSONB,
      allowNull: true,
    });

    await queryInterface.addIndex('enterprise_cities', ['auto_sync_last_run_at']);
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('enterprise_cities', ['auto_sync_last_run_at']);
    await queryInterface.removeColumn('enterprise_cities', 'auto_sync_last_summary');
    await queryInterface.removeColumn('enterprise_cities', 'auto_sync_last_status');
    await queryInterface.removeColumn('enterprise_cities', 'auto_sync_last_run_at');
  },
};

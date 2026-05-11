'use strict';

/**
 * Inscrições para o auto-sync recorrente.
 * Presença na tabela = empreendimento entra no cron diário.
 * Ausência = só é sincronizado manualmente.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('bills_auto_sync_subscriptions', {
      enterprise_city_id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        allowNull: false,
      },
      enabled_by:    { type: Sequelize.STRING(120), allowNull: true },
      enabled_at:    { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      created_at:    { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at:    { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('bills_auto_sync_subscriptions');
  },
};

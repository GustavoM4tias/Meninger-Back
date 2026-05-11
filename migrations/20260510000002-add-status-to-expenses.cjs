'use strict';

/**
 * Propaga o status da parcela do Sienge para o Expense local.
 *
 * - status: 'open' | 'paid' | 'cancelled' — derivado da `situation` da parcela ao sincronizar.
 * - paid_at: data do pagamento (preenchida quando status muda para 'paid').
 *
 * Expenses cancelados não somem do banco — ficam ocultos por filtro no listMonth/summarizeAllMonth.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('expenses', 'status', {
      type: Sequelize.STRING(20),
      allowNull: false,
      defaultValue: 'open',
    });

    await queryInterface.addColumn('expenses', 'paid_at', {
      type: Sequelize.DATEONLY,
      allowNull: true,
    });

    await queryInterface.addIndex('expenses', ['status']);
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('expenses', ['status']);
    await queryInterface.removeColumn('expenses', 'paid_at');
    await queryInterface.removeColumn('expenses', 'status');
  },
};

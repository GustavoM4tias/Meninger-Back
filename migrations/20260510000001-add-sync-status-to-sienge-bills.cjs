'use strict';

/**
 * Adiciona controle de re-sincronização e status de pagamento em sienge_bills.
 *
 * - is_settled: true quando todas as parcelas estão liquidadas (pagas/canceladas) ou o bill foi cancelado.
 *   Enquanto false, o auto-sync re-busca installments diariamente.
 * - current_status: estado de negócio agregado ('open' | 'paid' | 'cancelled' | 'partial').
 * - installments_synced_at: última leitura efetiva das parcelas no Sienge.
 * - last_full_sync_at: última atualização do bill via /v1/bills (catch de changedDate, notes, valor).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('sienge_bills', 'is_settled', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    await queryInterface.addColumn('sienge_bills', 'current_status', {
      type: Sequelize.STRING(20),
      allowNull: false,
      defaultValue: 'open',
    });

    await queryInterface.addColumn('sienge_bills', 'installments_synced_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    await queryInterface.addColumn('sienge_bills', 'last_full_sync_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    await queryInterface.addIndex('sienge_bills', ['is_settled']);
    await queryInterface.addIndex('sienge_bills', ['current_status']);
    await queryInterface.addIndex('sienge_bills', ['installments_synced_at']);
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('sienge_bills', ['installments_synced_at']);
    await queryInterface.removeIndex('sienge_bills', ['current_status']);
    await queryInterface.removeIndex('sienge_bills', ['is_settled']);
    await queryInterface.removeColumn('sienge_bills', 'last_full_sync_at');
    await queryInterface.removeColumn('sienge_bills', 'installments_synced_at');
    await queryInterface.removeColumn('sienge_bills', 'current_status');
    await queryInterface.removeColumn('sienge_bills', 'is_settled');
  },
};

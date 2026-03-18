'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('payment_launches', 'rid_email_sent', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn('payment_launches', 'rid_email_sent_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('payment_launches', 'rid_requested_by_email', {
      type: Sequelize.STRING,
      allowNull: true,
      comment: 'Email do usuário que solicitou o cadastro (copiado no envio)',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('payment_launches', 'rid_email_sent');
    await queryInterface.removeColumn('payment_launches', 'rid_email_sent_at');
    await queryInterface.removeColumn('payment_launches', 'rid_requested_by_email');
  },
};

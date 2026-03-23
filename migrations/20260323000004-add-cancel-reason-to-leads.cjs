'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('leads', 'motivo_cancelamento', {
      type: Sequelize.STRING(255),
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn('leads', 'submotivo_cancelamento', {
      type: Sequelize.TEXT,
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('leads', 'motivo_cancelamento');
    await queryInterface.removeColumn('leads', 'submotivo_cancelamento');
  },
};

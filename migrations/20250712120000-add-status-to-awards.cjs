'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('awards', 'status', {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: 'iniciado'
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('awards', 'status');
  }
};

'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('enterprise_condition_modules', 'appraisal_faixas', {
      type: Sequelize.JSONB,
      allowNull: true,
      defaultValue: null,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('enterprise_condition_modules', 'appraisal_faixas');
  },
};

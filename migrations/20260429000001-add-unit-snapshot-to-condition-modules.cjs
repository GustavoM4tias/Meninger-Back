'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableDesc = await queryInterface.describeTable('enterprise_condition_modules');
    if (!tableDesc.unit_snapshot) {
      await queryInterface.addColumn('enterprise_condition_modules', 'unit_snapshot', {
        type: Sequelize.JSONB,
        allowNull: true,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('enterprise_condition_modules', 'unit_snapshot');
  },
};

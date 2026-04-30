'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableDesc = await queryInterface.describeTable('chat_feedback');
    if (!tableDesc.context) {
      await queryInterface.addColumn('chat_feedback', 'context', {
        type: Sequelize.JSONB,
        allowNull: true,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('chat_feedback', 'context');
  },
};

// migrations/20250701180432-create-token-usage.cjs
'use strict';

module.exports = {
  async up (queryInterface, Sequelize) {
    await queryInterface.createTable('token_usages', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      model: {
        type: Sequelize.STRING,
        allowNull: false
      },
      tokens_used: {                   // <- snake_case
        type: Sequelize.INTEGER,
        allowNull: false
      },
      context: {
        type: Sequelize.STRING
      },
      created_at: {                    // <- snake_case
        type: Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW')
      },
      updated_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW')
      }
    });
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.dropTable('token_usages');
  }
};

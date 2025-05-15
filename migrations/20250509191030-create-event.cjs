'use strict';
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('events', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      title:         { type: Sequelize.STRING(255), allowNull: false },
      description:   { type: Sequelize.TEXT,        allowNull: false },
      post_date:     { 
        type: Sequelize.DATE, 
        allowNull: false, 
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') 
      },
      event_date:    { type: Sequelize.DATE, allowNull: false },
      tags:          { type: Sequelize.JSON, allowNull: true },
      images:        { type: Sequelize.JSON, allowNull: true },
      address:       { type: Sequelize.JSON, allowNull: true },
      created_by:    { type: Sequelize.STRING(255), allowNull: false },
    });
  },
  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('events');
  }
};

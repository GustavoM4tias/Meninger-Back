'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('tr_satellite_enterprises', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      satellite_enterprise_id:   { type: Sequelize.INTEGER, allowNull: false },
      satellite_enterprise_name: { type: Sequelize.STRING,  allowNull: true  },
      partner_enterprise_ids: {
        type: Sequelize.ARRAY(Sequelize.INTEGER),
        allowNull: false,
        defaultValue: []
      },
      description: { type: Sequelize.STRING, allowNull: true },
      active:      { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at:  { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at:  { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });

    await queryInterface.addIndex('tr_satellite_enterprises', ['satellite_enterprise_id']);
    await queryInterface.addIndex('tr_satellite_enterprises', ['active']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('tr_satellite_enterprises');
  },
};

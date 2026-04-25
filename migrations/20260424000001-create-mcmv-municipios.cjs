'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('mcmv_municipios', {
      id:           { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      co_ibge:      { type: Sequelize.STRING(10), allowNull: false, unique: true },
      no_municipio: { type: Sequelize.STRING(150), allowNull: false },
      sg_uf:        { type: Sequelize.STRING(2), allowNull: false },
      vr_faixa2:    { type: Sequelize.INTEGER, allowNull: false },
      co_periodo:   { type: Sequelize.STRING(8), allowNull: true },
      created_at:   { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at:   { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });

    await queryInterface.addIndex('mcmv_municipios', ['no_municipio']);
    await queryInterface.addIndex('mcmv_municipios', ['sg_uf']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('mcmv_municipios');
  },
};

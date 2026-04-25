'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('mcmv_municipios', 'no_regiao',        { type: Sequelize.STRING(30), allowNull: true });
    await queryInterface.addColumn('mcmv_municipios', 'co_recorte',       { type: Sequelize.STRING(2),  allowNull: true });
    await queryInterface.addColumn('mcmv_municipios', 'co_grupo_regional',{ type: Sequelize.INTEGER,    allowNull: true });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('mcmv_municipios', 'no_regiao');
    await queryInterface.removeColumn('mcmv_municipios', 'co_recorte');
    await queryInterface.removeColumn('mcmv_municipios', 'co_grupo_regional');
  },
};

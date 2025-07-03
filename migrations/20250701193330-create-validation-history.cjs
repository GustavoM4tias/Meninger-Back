'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('validation_histories', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      empreendimento: {
        type: Sequelize.STRING,
        allowNull: false
      },
      cliente: {
        type: Sequelize.STRING,
        allowNull: false
      },
      status: {
        type: Sequelize.ENUM('APROVADO', 'REPROVADO', 'ERRO'),
        allowNull: false
      },
      mensagens: {
        type: Sequelize.JSON,
        allowNull: false
      },
      tokens_used: {
        type: Sequelize.INTEGER,
        allowNull: false
      },
      model: {
        type: Sequelize.STRING,
        allowNull: false
      },
      created_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW')
      },
      updated_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW')
      }
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('validation_histories');
  }
};

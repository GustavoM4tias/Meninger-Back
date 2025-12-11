'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('awards', 'created_by', {
      type: Sequelize.INTEGER,
      allowNull: true,
    })

    await queryInterface.addColumn('awards', 'created_by_name', {
      type: Sequelize.STRING,
      allowNull: true,
    })

    await queryInterface.addColumn('awards', 'updated_by', {
      type: Sequelize.INTEGER,
      allowNull: true,
    })

    await queryInterface.addColumn('awards', 'updated_by_name', {
      type: Sequelize.STRING,
      allowNull: true,
    })

    await queryInterface.createTable('award_logs', {
      id: {
        type: Sequelize.BIGINT,
        autoIncrement: true,
        primaryKey: true,
      },
      award_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'awards',
          key: 'id',
        },
        onDelete: 'CASCADE',
      },
      action: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      user_name: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      metadata: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    })
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('award_logs')
    await queryInterface.removeColumn('awards', 'created_by')
    await queryInterface.removeColumn('awards', 'created_by_name')
    await queryInterface.removeColumn('awards', 'updated_by')
    await queryInterface.removeColumn('awards', 'updated_by_name')
  }
}

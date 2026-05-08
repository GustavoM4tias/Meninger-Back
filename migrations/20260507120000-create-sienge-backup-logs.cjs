'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('sienge_backup_logs', {
      id:              { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      started_at:      { type: Sequelize.DATE, allowNull: false },
      finished_at:     { type: Sequelize.DATE, allowNull: true },
      status:          { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'running' },
      stage:           { type: Sequelize.STRING(50), allowNull: true },
      file_name:       { type: Sequelize.STRING(255), allowNull: true },
      file_size_bytes: { type: Sequelize.BIGINT, allowNull: true },
      md5_expected:    { type: Sequelize.STRING(64), allowNull: true },
      md5_actual:      { type: Sequelize.STRING(64), allowNull: true },
      bucket_object:   { type: Sequelize.STRING(255), allowNull: true },
      duration_ms:     { type: Sequelize.INTEGER, allowNull: true },
      error_message:   { type: Sequelize.TEXT, allowNull: true },
      triggered_by:    { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'cron' },
      created_at:      { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at:      { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });

    await queryInterface.addIndex('sienge_backup_logs', ['status']);
    await queryInterface.addIndex('sienge_backup_logs', ['started_at']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('sienge_backup_logs');
  },
};

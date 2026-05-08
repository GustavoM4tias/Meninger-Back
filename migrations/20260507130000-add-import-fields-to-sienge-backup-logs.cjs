'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('sienge_backup_logs', 'import_status', {
      type: Sequelize.STRING(20),
      allowNull: true,
    });
    await queryInterface.addColumn('sienge_backup_logs', 'import_job_name', {
      type: Sequelize.STRING(60),
      allowNull: true,
    });
    await queryInterface.addColumn('sienge_backup_logs', 'import_started_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('sienge_backup_logs', 'import_finished_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('sienge_backup_logs', 'import_duration_ms', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('sienge_backup_logs', 'import_error_message', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn('sienge_backup_logs', 'cleaned_objects_count', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('sienge_backup_logs', 'cleaned_objects_count');
    await queryInterface.removeColumn('sienge_backup_logs', 'import_error_message');
    await queryInterface.removeColumn('sienge_backup_logs', 'import_duration_ms');
    await queryInterface.removeColumn('sienge_backup_logs', 'import_finished_at');
    await queryInterface.removeColumn('sienge_backup_logs', 'import_started_at');
    await queryInterface.removeColumn('sienge_backup_logs', 'import_job_name');
    await queryInterface.removeColumn('sienge_backup_logs', 'import_status');
  },
};

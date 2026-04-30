'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableDesc = await queryInterface.describeTable('enterprise_condition_modules');

    const cols = {
      cef_package_paid_by:        { type: Sequelize.STRING(20),     allowNull: true },
      cef_package_avg_value:      { type: Sequelize.DECIMAL(12, 2), allowNull: true },
      itbi_exempt:                { type: Sequelize.BOOLEAN,        allowNull: true, defaultValue: false },
      itbi_avg_value:             { type: Sequelize.DECIMAL(12, 2), allowNull: true },
      itbi_exemption_doc_url:     { type: Sequelize.TEXT,           allowNull: true },
      cartorio_prenotacao_value:  { type: Sequelize.DECIMAL(12, 2), allowNull: true },
      cartorio_registration_value:{ type: Sequelize.DECIMAL(12, 2), allowNull: true },
      cartorio_paid_by:           { type: Sequelize.STRING(20),     allowNull: true },
    };

    for (const [name, def] of Object.entries(cols)) {
      if (!tableDesc[name]) {
        await queryInterface.addColumn('enterprise_condition_modules', name, def);
      }
    }
  },

  async down(queryInterface) {
    const cols = [
      'cef_package_paid_by',
      'cef_package_avg_value',
      'itbi_exempt',
      'itbi_avg_value',
      'itbi_exemption_doc_url',
      'cartorio_prenotacao_value',
      'cartorio_registration_value',
      'cartorio_paid_by',
    ];
    for (const name of cols) {
      await queryInterface.removeColumn('enterprise_condition_modules', name);
    }
  },
};

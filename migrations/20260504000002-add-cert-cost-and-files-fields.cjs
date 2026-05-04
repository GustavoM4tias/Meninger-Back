'use strict';

/**
 * Adiciona campos novos em enterprise_condition_modules:
 *  - commission_note: observações livres sobre a comissão
 *  - digital_cert_has_cost / digital_cert_cost: custo da certificação digital
 *    (sempre pago pela Menin, entra automático no resumo de custos)
 *  - enterprise_files_url: URL para arquivos do empreendimento (gera QR Code no resumo)
 */

module.exports = {
    async up(queryInterface, Sequelize) {
        const tableDesc = await queryInterface.describeTable('enterprise_condition_modules');

        const cols = {
            commission_note:        { type: Sequelize.TEXT,           allowNull: true },
            digital_cert_has_cost:  { type: Sequelize.BOOLEAN,        allowNull: true, defaultValue: false },
            digital_cert_cost:      { type: Sequelize.DECIMAL(12, 2), allowNull: true },
            enterprise_files_url:   { type: Sequelize.TEXT,           allowNull: true },
        };

        for (const [name, def] of Object.entries(cols)) {
            if (!tableDesc[name]) {
                await queryInterface.addColumn('enterprise_condition_modules', name, def);
            }
        }
    },

    async down(queryInterface) {
        for (const name of ['commission_note', 'digital_cert_has_cost', 'digital_cert_cost', 'enterprise_files_url']) {
            await queryInterface.removeColumn('enterprise_condition_modules', name).catch(() => {});
        }
    },
};

'use strict';

/**
 * Permite fichas avulsas (sem vínculo com empreendimento do CV CRM):
 *  - idempreendimento agora aceita NULL
 *  - novo campo display_name identifica a ficha quando avulsa
 */

module.exports = {
    async up(queryInterface, Sequelize) {
        const tableDesc = await queryInterface.describeTable('enterprise_conditions');

        // Permite NULL em idempreendimento
        if (tableDesc.idempreendimento && tableDesc.idempreendimento.allowNull === false) {
            await queryInterface.changeColumn('enterprise_conditions', 'idempreendimento', {
                type: Sequelize.INTEGER,
                allowNull: true,
            });
        }

        // Adiciona display_name
        if (!tableDesc.display_name) {
            await queryInterface.addColumn('enterprise_conditions', 'display_name', {
                type: Sequelize.STRING(200),
                allowNull: true,
            });
        }
    },

    async down(queryInterface, Sequelize) {
        await queryInterface.removeColumn('enterprise_conditions', 'display_name').catch(() => {});
        await queryInterface.changeColumn('enterprise_conditions', 'idempreendimento', {
            type: Sequelize.INTEGER,
            allowNull: false,
        });
    },
};

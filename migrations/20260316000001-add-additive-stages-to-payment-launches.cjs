'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        // PostgreSQL não permite remover valores de ENUM, apenas adicionar.
        // Adicionamos os novos estágios do fluxo de aditivos.
        const newValues = [
            'creating_additive',
            'additive_created',
            'additive_error',
            'awaiting_authorization',
        ];

        for (const value of newValues) {
            await queryInterface.sequelize.query(
                `ALTER TYPE "enum_payment_launches_pipeline_stage" ADD VALUE IF NOT EXISTS '${value}';`
            );
        }
    },

    async down(queryInterface, Sequelize) {
        // Não é possível remover valores de um ENUM no PostgreSQL sem recriar o tipo.
        // Para reverter, seria necessário uma operação manual de recriação da coluna.
        console.warn('down() não remove valores de ENUM no PostgreSQL. Operação ignorada.');
    },
};

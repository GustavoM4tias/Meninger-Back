'use strict';

/**
 * Adiciona o valor 'closed' ao enum de status da tabela enterprise_conditions.
 * Estado terminal: empreendimento foi finalizado, ficha não evolui mais e
 * o scheduler de auto-geração mensal não cria novas fichas para ele.
 */

module.exports = {
    async up(queryInterface) {
        await queryInterface.sequelize.query(`
            ALTER TYPE "enum_enterprise_conditions_status" ADD VALUE IF NOT EXISTS 'closed';
        `);
    },

    async down() {
        // PostgreSQL não suporta remover valores de um enum sem recriar o tipo.
        // No-op intencional — voltar atrás exigiria recriar o tipo e mover dados.
    },
};

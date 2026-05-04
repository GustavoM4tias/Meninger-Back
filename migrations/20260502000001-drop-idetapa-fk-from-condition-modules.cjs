'use strict';

/**
 * BUG: a coluna `enterprise_condition_modules.idetapa` tinha FOREIGN KEY
 * REFERENCES cv_enterprise_stages(idetapa) ON DELETE SET NULL.
 *
 * O EnterpriseSyncService.js faz CvEnterpriseStage.destroy(...) + recreate
 * quando sincroniza dados do CV CRM. Cada vez que isso rodava, a FK disparava
 * o ON DELETE SET NULL e zerava `idetapa` em TODOS os módulos vinculados,
 * desfazendo silenciosamente os links que o usuário tinha feito via dropdown.
 *
 * Como cv_enterprise_stages é uma tabela de espelho de sistema externo (CV CRM)
 * que pode ser deletada/recriada a qualquer momento, idetapa precisa ser uma
 * REFERÊNCIA SOFT (sem constraint) — o frontend já lida graciosamente com etapas
 * inexistentes ("Etapa #X" como fallback).
 */

module.exports = {
    async up(queryInterface) {
        // Nome da constraint conforme retornado pelo information_schema
        const constraintName = 'enterprise_condition_modules_idetapa_fkey';
        await queryInterface.sequelize.query(
            `ALTER TABLE enterprise_condition_modules DROP CONSTRAINT IF EXISTS "${constraintName}"`
        );
    },

    async down(queryInterface, Sequelize) {
        // Recria a FK original (mas mantendo ON DELETE SET NULL para preservar comportamento histórico)
        await queryInterface.sequelize.query(`
            ALTER TABLE enterprise_condition_modules
            ADD CONSTRAINT enterprise_condition_modules_idetapa_fkey
            FOREIGN KEY (idetapa) REFERENCES cv_enterprise_stages(idetapa)
            ON UPDATE CASCADE ON DELETE SET NULL
        `);
    },
};

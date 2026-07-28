// lib/ensureSignupApprovalSchema.js
//
// Fluxo de aprovação de cadastro (primeiro acesso Microsoft) + alçadas padrão
// por departamento. Duas fases, ambas idempotentes:
//
//   ensureSignupApprovalColumns  — ADD COLUMN (roda CEDO, antes do sync, para
//     fechar a janela "column X does not exist" enquanto o app já atende):
//       users.approval_status            VARCHAR(20) NOT NULL DEFAULT 'approved'
//       permission_profiles.department_id INTEGER NULL → departments(id)
//
//   seedDepartmentDefaultProfiles — para cada departamento ativo SEM perfil
//     padrão vinculado, cria "Padrão - <nome>" com um conjunto inicial de rotas
//     de visualização (base comum + rotas da área, por palavra-chave do nome).
//     O admin refina depois na tela de Alçadas > Perfis. Nunca sobrescreve
//     perfis existentes; se já houver perfil com o mesmo nome, apenas vincula.

import db from '../models/sequelize/index.js';

export async function ensureSignupApprovalColumns() {
    await db.sequelize.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) NOT NULL DEFAULT 'approved';
    `);
    // Departamento escolhido no formulário de primeiro acesso (cargo fica com o admin).
    await db.sequelize.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS signup_department_id INTEGER NULL REFERENCES departments(id);
    `);
    // 'pending' sem cidade = criado antes do estado 'incomplete' existir e SEM o
    // formulário enviado (o envio exige cidade) → volta para fora da fila de
    // aprovação. Idempotente: nunca casa com um formulário concluído.
    await db.sequelize.query(`
        UPDATE users SET approval_status = 'incomplete'
        WHERE approval_status = 'pending' AND (city IS NULL OR city = '');
    `);
    // permission_profiles pode ainda não existir num banco novo (sync cria depois);
    // o DO-block evita erro nesse caso — o vínculo é criado pelo próprio sync.
    await db.sequelize.query(`
        DO $$
        BEGIN
            IF to_regclass('public.permission_profiles') IS NOT NULL THEN
                ALTER TABLE permission_profiles
                ADD COLUMN IF NOT EXISTS department_id INTEGER NULL REFERENCES departments(id);
            END IF;
        END $$;
    `);
}

// Rotas de visualização liberadas para todo departamento (transversais).
const COMMON_ROUTES = [
    '/checklists',
    '/aprovacoes',
    '/settings/organograma',
    '/microsoft/teams',
];

// Rotas extras por área, casadas por palavra-chave no nome/código do depto.
const ROUTES_BY_DEPT_KEYWORD = [
    [/marketing/i, [
        '/marketing/events',
        '/marketing/leads',
        '/marketing/stand-vendas',
    ]],
    [/comercial|vendas/i, [
        '/comercial/sales-projection',
        '/comercial/faturamento',
        '/comercial/conditions',
        '/comercial/mcmv',
        '/comercial/buildings',
        '/comercial/imobiliarias',
    ]],
    [/financeiro|cont[aá]b/i, [
        '/financeiro/titulos',
        '/financeiro/custos',
        '/financeiro/consulta-cef',
        '/financeiro/paymentflow',
    ]],
];

export async function seedDepartmentDefaultProfiles() {
    const departments = await db.Department.findAll({ where: { active: true } });
    let created = 0;

    for (const dept of departments) {
        const linked = await db.PermissionProfile.findOne({
            where: { department_id: dept.id, active: true },
        });
        if (linked) continue;

        const routes = new Set(COMMON_ROUTES);
        const haystack = `${dept.name} ${dept.code || ''}`;
        for (const [regex, extra] of ROUTES_BY_DEPT_KEYWORD) {
            if (regex.test(haystack)) extra.forEach(r => routes.add(r));
        }

        const name = `Padrão - ${dept.name}`;
        const byName = await db.PermissionProfile.findOne({ where: { name } });
        if (byName) {
            // Perfil homônimo já existe (ex.: criado à mão): só vincula, sem mexer nas rotas.
            await byName.update({ department_id: dept.id, active: true });
            continue;
        }

        await db.PermissionProfile.create({
            name,
            description: `Alçadas padrão de visualização aplicadas automaticamente ao ativar usuários novos do departamento ${dept.name}. Edite à vontade.`,
            routes: [...routes],
            department_id: dept.id,
        });
        created += 1;
    }

    if (created) {
        console.log(`✅ [SchemaPatch] Perfis padrão de alçada criados para ${created} departamento(s).`);
    }
}

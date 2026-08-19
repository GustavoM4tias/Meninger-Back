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
//   seedDepartmentDefaultProfiles — mantém um perfil PADRÃO por departamento
//     ativo ("Padrão - <nome>"), com o conjunto de telas curado da área
//     (DEFAULT_PROFILE_ROUTES abaixo). Regras:
//       • departamento sem perfil padrão → cria com as telas da área;
//       • perfil padrão existente e NUNCA editado (routes_customized=false) →
//         re-sincroniza as telas (o padrão evolui junto com o sistema);
//       • perfil editado pelo admin → não encosta nas rotas (só no vínculo).
//     "Restaurar padrão" na tela de Alçadas volta o perfil para este conjunto.

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

// ── Conjunto padrão de telas por departamento ────────────────────────────────
//
// Só entram telas DELEGÁVEIS (gerenciadas por alçada no navRegistry). Tela
// exclusiva de admin — no código (Central Meta, Boleto Caixa, Cancelamentos,
// Cérebro da Eme, Usuários, Alçadas…) ou travada pelo admin na tela de Alçadas
// — nunca é liberada por perfil, então não aparece aqui.
//
// Critério: cada departamento recebe a operação da PRÓPRIA área + o que ele
// consome de outras áreas no dia a dia. É ponto de partida: o admin refina na
// tela de Alçadas > Perfis e, a partir da primeira edição, o seed não mexe mais.

// Transversais — todo departamento enxerga.
const COMMON_ROUTES = [
    '/checklists',
    '/aprovacoes',
    '/settings/organograma',
    '/microsoft/teams',
];

const MARKETING = ['/marketing/events', '/marketing/leads', '/marketing/stand-vendas', '/marketing/viabilidade'];
// Relatorios comerciais: cada um e uma tela com alcada propria
// (/comercial/relatorios/<relatorio>, desde 2026-08-17). O Comercial leva todos;
// as demais areas levam so o que ja enxergavam.
const RELATORIOS = [
    '/comercial/relatorios/faturamento', '/comercial/relatorios/projecao',
    '/comercial/relatorios/leads', '/comercial/relatorios/imobiliarias',
    '/comercial/relatorios/corretores',
];
const COMERCIAL = [
    ...RELATORIOS, '/comercial/projections', '/comercial/precadastros',
    '/comercial/reservas-report', '/comercial/conditions',
    '/comercial/mcmv', '/comercial/workflow/groups', '/comercial/buildings', '/comercial/imobiliarias',
];
const FINANCEIRO = ['/financeiro/titulos', '/financeiro/custos', '/financeiro/consulta-cef', '/financeiro/paymentflow'];
const MICROSOFT_EXTRA = ['/microsoft/sharepoint', '/microsoft/planner'];

// code do departamento (ensureOrgDefaultsSchema) → telas da área.
const DEFAULT_PROFILE_ROUTES = {
    DIRETORIA: [...MARKETING, ...COMERCIAL, ...FINANCEIRO, ...MICROSOFT_EXTRA, '/validator', '/tools/bucket-upload'],
    SOCIO_FUNDADOR: [...MARKETING, ...COMERCIAL, ...FINANCEIRO, ...MICROSOFT_EXTRA, '/validator', '/tools/bucket-upload'],

    COMERCIAL: [...COMERCIAL, '/marketing/events', '/marketing/leads', '/validator'],
    MARKETING: [...MARKETING, '/comercial/buildings', '/comercial/relatorios/projecao'],
    FINANCEIRO: [...FINANCEIRO, '/marketing/viabilidade', '/comercial/relatorios/faturamento', '/comercial/conditions'],
    CONTABILIDADE: ['/financeiro/titulos', '/financeiro/custos', '/financeiro/paymentflow', '/comercial/relatorios/faturamento'],

    // Áreas de apoio: só o que realmente consomem.
    ADMINISTRATIVO: ['/financeiro/titulos', '/financeiro/paymentflow', ...MICROSOFT_EXTRA],
    SUPRIMENTOS: ['/financeiro/titulos', '/financeiro/custos', '/financeiro/paymentflow'],
    ENGENHARIA: ['/financeiro/custos', '/comercial/buildings', '/marketing/stand-vendas'],
    NOVOS_NEGOCIOS: ['/marketing/viabilidade', '/comercial/buildings', '/comercial/relatorios/projecao'],
    LEGALIZACAO: ['/comercial/buildings', '/comercial/precadastros', '/validator'],
    JURIDICO: ['/comercial/conditions', '/comercial/buildings', '/comercial/reservas-report', '/validator'],
    ASSISTENCIA_TECNICA: ['/comercial/buildings'],
    RH: [...MICROSOFT_EXTRA],
    TI: [...MICROSOFT_EXTRA, '/tools/bucket-upload'],
};

// Departamento criado à mão pelo admin (fora do conjunto padrão): casa por
// palavra-chave do nome para não nascer só com o comum.
const ROUTES_BY_DEPT_KEYWORD = [
    [/marketing|m[ií]dia|comunica/i, DEFAULT_PROFILE_ROUTES.MARKETING],
    [/comercial|vendas|corretor/i, DEFAULT_PROFILE_ROUTES.COMERCIAL],
    [/financ|cont[aá]b|fiscal/i, DEFAULT_PROFILE_ROUTES.FINANCEIRO],
    [/obra|engenharia|t[eé]cnic/i, DEFAULT_PROFILE_ROUTES.ENGENHARIA],
    [/suprimento|compra/i, DEFAULT_PROFILE_ROUTES.SUPRIMENTOS],
    [/diretoria|s[oó]cio|presid/i, DEFAULT_PROFILE_ROUTES.DIRETORIA],
    [/jur[ií]dic|legaliza/i, DEFAULT_PROFILE_ROUTES.JURIDICO],
];

/** Telas padrão de um departamento (comum + área). Exportada para o "Restaurar padrão". */
export function defaultRoutesForDepartment(dept) {
    const routes = new Set(COMMON_ROUTES);
    const byCode = DEFAULT_PROFILE_ROUTES[String(dept?.code || '').toUpperCase()];
    if (byCode) {
        byCode.forEach(r => routes.add(r));
    } else {
        const haystack = `${dept?.name || ''} ${dept?.code || ''}`;
        for (const [regex, extra] of ROUTES_BY_DEPT_KEYWORD) {
            if (regex.test(haystack)) extra.forEach(r => routes.add(r));
        }
    }
    return [...routes];
}

const defaultDescription = (deptName) =>
    `Perfil padrão do departamento ${deptName}: telas da área liberadas para visualização, aplicado automaticamente ao ativar usuários novos desse departamento. Edite à vontade - depois da primeira edição o sistema para de atualizar este perfil sozinho.`;

export async function seedDepartmentDefaultProfiles() {
    const departments = await db.Department.findAll({ where: { active: true } });
    let created = 0;
    let synced = 0;

    for (const dept of departments) {
        const routes = defaultRoutesForDepartment(dept);
        const name = `Padrão - ${dept.name}`;

        // Perfil padrão da área: pelo vínculo com o departamento ou pelo nome
        // canônico (cobre bancos anteriores ao seed_code).
        const profile = await db.PermissionProfile.findOne({ where: { department_id: dept.id, active: true } })
            || await db.PermissionProfile.findOne({ where: { name } });

        if (!profile) {
            await db.PermissionProfile.create({
                name,
                description: defaultDescription(dept.name),
                routes,
                department_id: dept.id,
                seed_code: dept.code || null,
                routes_customized: false,
            });
            created += 1;
            continue;
        }

        const patch = { department_id: dept.id, active: true };
        if (!profile.seed_code) patch.seed_code = dept.code || null;

        // Rotas: só re-sincroniza enquanto o admin não editou o perfil.
        if (!profile.routes_customized) {
            const before = [...(profile.routes || [])].sort().join(',');
            if (before !== [...routes].sort().join(',')) {
                patch.routes = routes;
                synced += 1;
            }
            if (!profile.description) patch.description = defaultDescription(dept.name);
        }

        await profile.update(patch);
    }

    if (created || synced) {
        console.log(`✅ [SchemaPatch] Perfis padrão de alçada: +${created} criado(s), ${synced} re-sincronizado(s) com o padrão da área.`);
    }
}

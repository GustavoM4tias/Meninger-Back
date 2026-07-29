// lib/ensureOrgDefaultsSchema.js
//
// Padrões de construtora para Departamentos e Cargos + backfill das FKs
// estruturadas de usuário (users.position_id / users.city_id).
//
//   - Seeds IDEMPOTENTES: cria o que falta (match por code OU name,
//     case-insensitive), nunca sobrescreve nome/descrição de registro
//     existente (cadastro do admin manda).
//   - Backfill: casa users.position/users.city (strings legadas) com
//     positions/user_cities por nome normalizado e grava as FKs. Não-casados
//     são apenas logados (nada quebra — o nome legado continua valendo).
//
// Roda todo boot (server.js → patches).

import db from '../models/sequelize/index.js';

const norm = (s) => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

// ── Departamentos padrão ─────────────────────────────────────────────────────
const DEFAULT_DEPARTMENTS = [
    ['ADMINISTRATIVO', 'Administrativo', 'Rotinas administrativas, contratos internos, frota, facilities e apoio às demais áreas.'],
    ['COMERCIAL', 'Comercial', 'Vendas, gestão de corretores/imobiliárias, reservas, fichas comerciais e relacionamento com o cliente comprador.'],
    ['DIRETORIA', 'Diretoria', 'Direção executiva da empresa: metas, resultados e decisões estratégicas.'],
    ['FINANCEIRO', 'Financeiro', 'Contas a pagar e receber, fluxo de caixa, boletos, conciliação e relatórios financeiros.'],
    ['MARKETING', 'Marketing', 'Captação de leads, campanhas, eventos, branding e comunicação com o mercado.'],
    ['NOVOS_NEGOCIOS', 'Novos Negócios', 'Prospecção de terrenos e áreas, estudos de viabilidade e parcerias para novos empreendimentos.'],
    ['LEGALIZACAO', 'Legalização', 'Aprovações em prefeitura e cartório, registro de incorporação, averbações e regularização dos empreendimentos.'],
    ['SOCIO_FUNDADOR', 'Sócio Fundador', 'Sócios fundadores da empresa.'],
    ['ENGENHARIA', 'Engenharia e Obras', 'Planejamento e execução de obras, orçamento, medições, qualidade e segurança do trabalho.'],
    ['SUPRIMENTOS', 'Suprimentos', 'Compras, cotações, negociação com fornecedores e gestão de materiais e insumos de obra.'],
    ['RH', 'Recursos Humanos', 'Recrutamento, departamento pessoal, treinamento e desenvolvimento das equipes.'],
    ['TI', 'Tecnologia da Informação', 'Sistemas, infraestrutura, integrações (CV/Sienge) e suporte tecnológico.'],
    ['JURIDICO', 'Jurídico', 'Contratos, contencioso, distratos e assessoria jurídica das operações.'],
    ['ASSISTENCIA_TECNICA', 'Assistência Técnica', 'Pós-obra: chamados de garantia, vistorias de entrega e manutenção nos empreendimentos entregues.'],
    ['CONTABILIDADE', 'Contabilidade', 'Escrituração contábil e fiscal, obrigações acessórias e apuração de impostos.'],
];

// ── Cargos padrão (code, name, deptCode, level, descrição) ───────────────────
const DEFAULT_POSITIONS = [
    ['SOCIO_FUNDADOR', 'Sócio Fundador', 'SOCIO_FUNDADOR', 0, 'Sócio fundador da empresa.'],
    ['DIRETOR', 'Diretor', 'DIRETORIA', 1, 'Direção executiva.'],
    ['GERENTE_COMERCIAL', 'Gerente Comercial', 'COMERCIAL', 2, 'Gestão do time comercial e das metas de venda.'],
    ['SUPERVISOR_COMERCIAL', 'Supervisor Comercial', 'COMERCIAL', 4, 'Supervisão dos corretores e do funil de vendas.'],
    ['CORRETOR', 'Corretor', 'COMERCIAL', 6, 'Atendimento e venda ao cliente comprador.'],
    ['GERENTE_FINANCEIRO', 'Gerente Financeiro', 'FINANCEIRO', 2, 'Gestão financeira: caixa, pagamentos e recebimentos.'],
    ['ANALISTA_FINANCEIRO', 'Analista Financeiro', 'FINANCEIRO', 5, 'Rotinas de contas a pagar/receber e conciliações.'],
    ['ASSISTENTE_FINANCEIRO', 'Assistente Financeiro', 'FINANCEIRO', 6, 'Apoio às rotinas financeiras.'],
    ['GERENTE_MARKETING', 'Gerente de Marketing', 'MARKETING', 2, 'Gestão de campanhas, verba e captação de leads.'],
    ['ANALISTA_MARKETING', 'Analista de Marketing', 'MARKETING', 5, 'Execução de campanhas, mídia e eventos.'],
    ['GERENTE_ADMINISTRATIVO', 'Gerente Administrativo', 'ADMINISTRATIVO', 2, 'Gestão das rotinas administrativas.'],
    ['ASSISTENTE_ADMINISTRATIVO', 'Assistente Administrativo', 'ADMINISTRATIVO', 6, 'Apoio administrativo geral.'],
    ['ENGENHEIRO_CIVIL', 'Engenheiro Civil', 'ENGENHARIA', 5, 'Gestão técnica da obra: execução, qualidade e prazos.'],
    ['MESTRE_OBRAS', 'Mestre de Obras', 'ENGENHARIA', 6, 'Coordenação das equipes de campo na obra.'],
    ['COMPRADOR', 'Comprador', 'SUPRIMENTOS', 6, 'Cotações e compras de materiais e serviços.'],
    ['ANALISTA_RH', 'Analista de RH', 'RH', 5, 'Recrutamento, DP e rotinas de pessoal.'],
    ['ANALISTA_TI', 'Analista de TI', 'TI', 5, 'Sistemas, suporte e integrações.'],
    ['ADVOGADO', 'Advogado', 'JURIDICO', 5, 'Assessoria jurídica e contratos.'],
    ['ANALISTA_LEGALIZACAO', 'Analista de Legalização', 'LEGALIZACAO', 5, 'Aprovações, registros e regularização.'],
    ['GERENTE_NOVOS_NEGOCIOS', 'Gerente de Novos Negócios', 'NOVOS_NEGOCIOS', 2, 'Prospecção de áreas e estudos de viabilidade.'],
    ['TECNICO_ASSISTENCIA', 'Técnico de Assistência', 'ASSISTENCIA_TECNICA', 6, 'Atendimento de garantias e vistorias pós-obra.'],
    ['CONTADOR', 'Contador', 'CONTABILIDADE', 5, 'Escrituração e obrigações fiscais.'],
    ['ESTAGIARIO', 'Estagiário', 'ADMINISTRATIVO', 8, 'Estágio supervisionado.'],
];

async function seedDepartments() {
    const existing = await db.Department.findAll();
    const byKey = new Map();
    for (const d of existing) {
        byKey.set(norm(d.code), d);
        byKey.set(norm(d.name), d);
    }
    let created = 0;
    for (const [code, name, description] of DEFAULT_DEPARTMENTS) {
        const found = byKey.get(norm(code)) || byKey.get(norm(name));
        if (found) {
            // Só completa descrição vazia — nunca sobrescreve texto do admin.
            if (!found.description && description) await found.update({ description });
            continue;
        }
        const row = await db.Department.create({ code, name, description, active: true });
        byKey.set(norm(code), row);
        byKey.set(norm(name), row);
        created++;
    }
    return { created, byKey };
}

async function seedPositions(deptByKey) {
    const existing = await db.Position.findAll();
    const byKey = new Map();
    for (const p of existing) {
        byKey.set(norm(p.code), p);
        byKey.set(norm(p.name), p);
    }
    let created = 0;
    for (const [code, name, deptCode, level, description] of DEFAULT_POSITIONS) {
        const found = byKey.get(norm(code)) || byKey.get(norm(name));
        if (found) {
            const patch = {};
            if (found.level == null) patch.level = level;
            if (!found.description && description) patch.description = description;
            if (Object.keys(patch).length) await found.update(patch);
            continue;
        }
        const dept = deptByKey.get(norm(deptCode));
        if (!dept) continue;
        const row = await db.Position.create({
            code, name, description, level,
            department_id: dept.id, is_internal: true, is_partner: false, active: true,
        });
        byKey.set(norm(code), row);
        byKey.set(norm(name), row);
        created++;
    }
    return { created };
}

async function backfillUserFks() {
    const [positions, cities, users] = await Promise.all([
        db.Position.findAll({ attributes: ['id', 'name'], raw: true }),
        db.UserCity.findAll({ attributes: ['id', 'name'], raw: true }),
        db.User.findAll({ attributes: ['id', 'username', 'position', 'city', 'position_id', 'city_id'] }),
    ]);
    const posByName = new Map(positions.map(p => [norm(p.name), p.id]));
    const cityByName = new Map(cities.map(c => [norm(c.name), c.id]));

    let linked = 0;
    const unmatched = [];
    for (const u of users) {
        const patch = {};
        if (!u.position_id) {
            const pid = posByName.get(norm(u.position));
            if (pid) patch.position_id = pid;
            else if (u.position) unmatched.push(`${u.username}: cargo "${u.position}"`);
        }
        if (!u.city_id) {
            const cid = cityByName.get(norm(u.city));
            if (cid) patch.city_id = cid;
            else if (u.city) unmatched.push(`${u.username}: cidade "${u.city}"`);
        }
        if (Object.keys(patch).length) {
            await u.update(patch, { hooks: false });
            linked++;
        }
    }
    return { linked, unmatched };
}

export async function ensureOrgDefaultsSchema() {
    const dep = await seedDepartments();
    const pos = await seedPositions(dep.byKey);
    const fk = await backfillUserFks();
    if (dep.created || pos.created || fk.linked) {
        console.log(`✅ [SchemaPatch] Org defaults: +${dep.created} departamento(s), +${pos.created} cargo(s), ${fk.linked} usuário(s) com FK preenchida.`);
    }
    if (fk.unmatched.length) {
        console.warn(`⚠️  [OrgDefaults] ${fk.unmatched.length} vínculo(s) de usuário sem match (resolver no cadastro):\n  - ${fk.unmatched.slice(0, 20).join('\n  - ')}${fk.unmatched.length > 20 ? `\n  … +${fk.unmatched.length - 20}` : ''}`);
    }
}

export default ensureOrgDefaultsSchema;

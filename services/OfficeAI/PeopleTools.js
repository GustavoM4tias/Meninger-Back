// services/OfficeAI/PeopleTools.js
//
// Tool da Eme sobre PESSOAS / ORGANOGRAMA (telas /settings/users e /settings/organograma):
//   - query_people: "quem é o admin de Marília?", "quem é o gestor do Marketing?",
//     "contato do fulano", "quem trabalha no Comercial de Bauru".
//
// A resposta traz cards de pessoa (type 'person_cards') que o front renderiza com
// modal de detalhe (ChatPersonCards.vue). Dados exibidos são os corporativos do
// cadastro de usuários (nome, cargo, departamento, cidade, e-mail, telefone,
// gestor, subordinados) — sistema interno, todos os usuários são funcionários.
//
// Segurança: contexts ['OFFICE'] (externo do Academy nunca enxerga) e somente
// usuários ATIVOS dos providers internos (INTERNAL/MICROSOFT).

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { registerTool } from './ToolRegistry.js';

const OFFICE_PROVIDERS = ['INTERNAL', 'MICROSOFT'];
const MAX_CARDS = 8;

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

async function loadDirectory() {
    const [users, positions, departments] = await Promise.all([
        db.User.findAll({
            where: { status: true, auth_provider: { [Op.in]: OFFICE_PROVIDERS } },
            attributes: ['id', 'username', 'email', 'position', 'city', 'role', 'phone', 'whatsapp_phone', 'manager_id', 'show_in_organogram'],
            order: [['username', 'ASC']],
            raw: true,
        }),
        db.Position.findAll({ attributes: ['name', 'department_id'], raw: true }),
        db.Department.findAll({ attributes: ['id', 'name'], raw: true }),
    ]);

    const deptById = new Map(departments.map(d => [d.id, d.name]));
    const deptByPosition = new Map(positions.map(p => [norm(p.name), deptById.get(p.department_id) || null]));
    const byId = new Map(users.map(u => [u.id, u]));
    const subordinates = new Map(); // managerId -> [users]
    for (const u of users) {
        if (!u.manager_id) continue;
        if (!subordinates.has(u.manager_id)) subordinates.set(u.manager_id, []);
        subordinates.get(u.manager_id).push(u);
    }
    const enrich = (u) => ({
        ...u,
        department: deptByPosition.get(norm(u.position)) || null,
        manager: u.manager_id ? (byId.get(u.manager_id) || null) : null,
        team: subordinates.get(u.id) || [],
    });
    return { users: users.map(enrich) };
}

function formatPersonList(items) {
    return items.map((u, n) => {
        const L = [`[${n + 1}] ${u.username}${u.role === 'admin' ? ' (ADMIN do sistema)' : ''} — ${u.position || 'sem cargo'}`];
        if (u.department) L.push(`Departamento: ${u.department}`);
        if (u.city) L.push(`Cidade: ${u.city}`);
        const contato = [u.email, (u.whatsapp_phone || u.phone) && `tel ${u.whatsapp_phone || u.phone}`].filter(Boolean);
        if (contato.length) L.push(`Contato: ${contato.join(' · ')}`);
        if (u.manager) L.push(`Gestor direto: ${u.manager.username}`);
        if (u.team.length) L.push(`Lidera ${u.team.length} pessoa(s): ${u.team.slice(0, 6).map(t => t.username).join(', ')}${u.team.length > 6 ? '…' : ''}`);
        return L.join('\n');
    }).join('\n\n');
}

function personCards(items) {
    return items.map(u => ({
        id: u.id,
        nome: u.username,
        cargo: u.position || null,
        departamento: u.department || null,
        cidade: u.city || null,
        admin: u.role === 'admin',
        email: u.email || null,
        telefone: u.whatsapp_phone || u.phone || null,
        gestor: u.manager ? { id: u.manager.id, nome: u.manager.username, cargo: u.manager.position || null } : null,
        equipe: u.team.slice(0, 12).map(t => ({ id: t.id, nome: t.username, cargo: t.position || null })),
        equipeTotal: u.team.length,
        noOrganograma: !!u.show_in_organogram,
    }));
}

registerTool({
    name: 'query_people',
    description: 'Consulta PESSOAS da empresa (usuários do Office e organograma): quem é o ADMINISTRADOR do sistema em uma cidade, quem é o GESTOR de um departamento/pessoa, cargo, departamento, cidade, contato (e-mail/telefone) e equipe liderada. Use quando o usuário perguntar "quem é o gestor/responsável de X", "quem é o admin de <cidade>", "contato do <nome>", "quem trabalha no <departamento>", "quem responde pelo Marketing". NUNCA invente nome, cargo ou contato — só afirme o que vier desta ferramenta.',
    parameters: {
        type: 'object',
        properties: {
            busca: { type: 'string', description: 'Nome (ou parte do nome) da pessoa procurada.' },
            departamento: { type: 'string', description: 'Filtra por departamento (ex: Marketing, Comercial, Financeiro).' },
            cargo: { type: 'string', description: 'Filtra por cargo (ex: Gerente, Analista).' },
            cidade: { type: 'string', description: 'Filtra por cidade.' },
            apenas: { type: 'string', enum: ['gestores', 'admins', 'todos'], description: '"gestores" = só quem lidera pessoas; "admins" = só administradores do sistema. Padrão: todos.' },
        },
    },
    requiredPermissions: [],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const { users } = await loadDirectory();

        let rows = users;
        const busca = norm(args?.busca);
        const dep = norm(args?.departamento);
        const cargo = norm(args?.cargo);
        const cidade = norm(args?.cidade);
        const apenas = ['gestores', 'admins', 'todos'].includes(args?.apenas) ? args.apenas : 'todos';

        if (busca) rows = rows.filter(u => norm(u.username).includes(busca) || norm(u.email).includes(busca));
        if (dep) rows = rows.filter(u => norm(u.department).includes(dep) || norm(u.position).includes(dep));
        if (cargo) rows = rows.filter(u => norm(u.position).includes(cargo));
        if (cidade) rows = rows.filter(u => norm(u.city).includes(cidade));
        if (apenas === 'admins') rows = rows.filter(u => u.role === 'admin');
        if (apenas === 'gestores') rows = rows.filter(u => u.team.length > 0);

        // Gestores primeiro (mais provável de ser a resposta de "quem é o gestor de X")
        rows = [...rows].sort((a, b) => (b.team.length - a.team.length) || a.username.localeCompare(b.username));

        const total = rows.length;
        const shown = rows.slice(0, MAX_CARDS);

        const out = {
            total,
            pessoas: formatPersonList(shown),
            message: total
                ? `${total} pessoa(s) no filtro (${shown.length} detalhada(s) no campo "pessoas"; cards com modal de detalhe JÁ estão na UI). Responda CURTO e direto ao que foi perguntado (quem é, contato, gestor...) usando SOMENTE estes dados — nunca invente nome/cargo/contato. "ADMIN do sistema" = administrador do Office; "Gestor direto" = superior imediato; "Lidera N pessoa(s)" = é gestor. O organograma completo fica em /settings/organograma.`
                : 'Nenhuma pessoa encontrada nesse filtro. Diga isso com clareza — não invente. Sugira conferir o organograma em /settings/organograma ou ajustar o nome/departamento.',
        };
        if (shown.length) {
            out.type = 'person_cards';
            out.title = 'Pessoas';
            out.cards = personCards(shown);
            out.screenLink = '/settings/organograma';
        }
        return { result: out, resultCount: total };
    },
});

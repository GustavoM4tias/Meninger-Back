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

// ── "Gestor" é CARGO, não aresta do organograma ──────────────────────────────
//
// `apenas: 'gestores'` filtrava por `team.length > 0` (tem subordinado cadastrado).
// Medido em 28/08/2026: "convide todos os gestores comerciais" convidou 6 e deixou
// 4 de fora - Alexsandra, Eliane, Sergio e Willian têm cargo "Gestor Comercial" e
// ZERO subordinados no organograma, então sumiam do filtro. Quem pede "os gestores"
// quer quem TEM O CARGO; a aresta do organograma é outra pergunta ("quem é o gestor
// DELE"), e essa continua respondida pela ordenação, que põe quem lidera na frente.
const CARGO_LIDERANCA = /(gestor|gerente|diretor|coordenador|supervisor|superintendente|head|l[ií]der)/i;
const ehLideranca = (u) => (u.team?.length > 0) || CARGO_LIDERANCA.test(String(u.position || ''));

// ── Plural do pedido x singular do cadastro ──────────────────────────────────
//
// O usuário fala "gestores comerciais" e o modelo repassa exatamente assim; no
// cadastro o cargo é "Gestor Comercial". Um `includes()` cru não casa NADA - e o
// filtro que não casa nada devolve a lista inteira ou vazia, os dois errados.
// Casamos token a token, cada um reduzido ao singular.
const singular = (w) => w
    .replace(/ais$/, 'al')
    .replace(/eis$/, 'el')
    .replace(/ois$/, 'ol')
    .replace(/oes$/, 'ao')
    .replace(/es$/, '')
    .replace(/s$/, '');

/** Todos os termos do filtro precisam aparecer em algum dos campos. */
function casaTermos(filtro, ...campos) {
    const alvo = campos.map(norm).filter(Boolean).join(' | ');
    const tokens = norm(filtro).split(/\s+/).filter(Boolean).map(singular);
    return tokens.length > 0 && tokens.every(t => alvo.includes(t));
}

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
            busca: { type: 'string', description: 'Nome, parte do nome ou e-mail da pessoa procurada. Use SEMPRE que o usuário citar alguém pelo nome.' },
            departamento: { type: 'string', description: 'Filtra por departamento (ex: Marketing, Comercial, Financeiro).' },
            cargo: { type: 'string', description: 'Filtra por cargo (ex: Gerente, Analista).' },
            cidade: { type: 'string', description: 'Filtra por cidade.' },
            apenas: { type: 'string', enum: ['gestores', 'admins', 'todos'], description: '"gestores" = quem tem cargo de liderança (gestor, gerente, coordenador, diretor, supervisor) OU lidera alguém no organograma - é o filtro certo para "todos os gestores do Comercial"; "admins" = só administradores do sistema. Padrão: todos.' },
        },
    },
    requiredPermissions: ['/settings/organograma'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const { users } = await loadDirectory();

        let rows = users;

        // O modelo escreve `nome`, `name`, `pessoa`, `q`... e a tool declarava
        // só `busca`. Sem os apelidos, o filtro não era aplicado e a resposta
        // era a EMPRESA INTEIRA - foi o que aconteceu ao procurar uma pessoa
        // só, e o usuário recebeu oito cartões.
        const termo = args?.busca ?? args?.nome ?? args?.name ?? args?.pessoa
                   ?? args?.termo ?? args?.q ?? args?.email;
        const busca = norm(termo);
        const dep = norm(args?.departamento);
        const cargo = norm(args?.cargo);
        const cidade = norm(args?.cidade);
        const apenas = ['gestores', 'admins', 'todos'].includes(args?.apenas) ? args.apenas : 'todos';

        if (busca) rows = rows.filter(u => norm(u.username).includes(busca) || norm(u.email).includes(busca));
        if (dep) rows = rows.filter(u => casaTermos(dep, u.department, u.position));
        if (cargo) rows = rows.filter(u => casaTermos(cargo, u.position));
        if (cidade) rows = rows.filter(u => norm(u.city).includes(cidade));
        if (apenas === 'admins') rows = rows.filter(u => u.role === 'admin');
        if (apenas === 'gestores') rows = rows.filter(ehLideranca);

        // Gestores primeiro (mais provável de ser a resposta de "quem é o gestor de X")
        rows = [...rows].sort((a, b) => (b.team.length - a.team.length) || a.username.localeCompare(b.username));

        // ── Procurou alguém e não achou? Diga isso. ──────────────────────
        // Devolver a lista toda quando a busca não casou é pior que devolver
        // nada: a pessoa pediu UM nome e recebe um catálogo, sem saber que a
        // busca falhou.
        if (busca && !rows.length) {
            return { result: {
                total: 0,
                naoAchou: termo,
                message: `Ninguém com "${termo}" no nome ou no e-mail. `
                       + 'Confirme a grafia ou peça por departamento/cidade. NÃO liste outras pessoas.',
            } };
        }

        const total = rows.length;
        const shown = rows.slice(0, MAX_CARDS);
        // A lista detalhada é cortada em MAX_CARDS e era a ÚNICA fonte de e-mail do
        // modelo: com 11 pessoas no filtro, "convide todos" virava convite para 8 -
        // sem ninguém perceber, porque o corte não aparecia em lugar nenhum. Os
        // e-mails saem inteiros aqui, e o corte da lista detalhada é anunciado.
        const emails = rows.map(u => u.email).filter(Boolean).slice(0, 100);
        const aviso = total > shown.length
            ? ` ATENÇÃO: só ${shown.length} de ${total} estão detalhadas em "pessoas". Para convite, e-mail ou qualquer lista do GRUPO INTEIRO, use TODOS os ${emails.length} endereços do campo "emails" - nunca só os detalhados.`
            : '';

        const out = {
            total,
            emails,
            pessoas: formatPersonList(shown),
            message: total
                ? `${total} pessoa(s) no filtro (${shown.length} detalhada(s) no campo "pessoas"; cards com modal de detalhe JÁ estão na UI).${aviso} Responda CURTO e direto ao que foi perguntado (quem é, contato, gestor...) usando SOMENTE estes dados — nunca invente nome/cargo/contato. "ADMIN do sistema" = administrador do Office; "Gestor direto" = superior imediato; "Lidera N pessoa(s)" = tem equipe no organograma - quem tem CARGO de gestor sem equipe também é gestor, não exclua da lista. O organograma completo fica em /settings/organograma.`
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

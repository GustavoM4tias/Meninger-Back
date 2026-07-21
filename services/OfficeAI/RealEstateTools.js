// services/OfficeAI/RealEstateTools.js
//
// Tools da Eme sobre IMOBILIÁRIAS parceiras (tela Comercial > Imobiliárias):
//   - imobiliarias_search:    consulta as imobiliárias do CV (contatos, gerente,
//                             empreendimentos vinculados, CRECI, origem).
//   - imobiliarias_cadastros: acompanha cadastros e convites feitos pelo Office
//                             (link público, status, submissões de link multi-uso).
//
// Princípios (iguais ao resto do registry):
//   - Segurança DENTRO do handler com base em `user` (nunca em args):
//     imobiliárias escopadas por cidade p/ não-admin (mesma regra da tela, via
//     realEstateReportService); cadastros: não-admin vê só os próprios.
//   - Dados internos → contexts: ['OFFICE'] apenas (usuário externo do Academy
//     nunca enxerga estas tools).
//   - O texto p/ o modelo vai em campos string; `cards[]` é cortado pelo
//     summarizeForGemini e chega só ao frontend (ChatImobiliariaCards.vue).

import db from '../../models/sequelize/index.js';
import { registerTool } from './ToolRegistry.js';
import { buildImobiliariasReport } from '../realestate/realEstateReportService.js';
import { onlyDigits } from '../realestate/realEstateRegistrationService.js';

const LP_HOST = process.env.LP_BASE_URL || 'https://lp.menin.com.br';
const SCREEN = '/comercial/imobiliarias';
const MAX_CARDS = 8;

const fmtDate = (d) => { try { return d ? new Date(d).toLocaleDateString('pt-BR') : null; } catch { return null; } };

// ── Texto p/ o MODELO (arrays são cortados; o modelo lê só isto) ─────────────
function formatImobiliariaList(items) {
    return items.map((i, n) => {
        const L = [`[${n + 1}] ${i.nome}${i.ativo === 'S' ? '' : ' (INATIVA)'} — CNPJ ${i.cnpj || 'não informado'}`];
        if (i.razao_social && i.razao_social !== i.nome) L.push(`Razão social: ${i.razao_social}`);
        if (i.cidades?.length) L.push(`Cidade(s): ${i.cidades.join(', ')}`);
        const contatos = [i.celular && `cel ${i.celular}`, i.telefone && `tel ${i.telefone}`, i.email].filter(Boolean);
        if (contatos.length) L.push(`Contato: ${contatos.join(' · ')}`);
        if (i.gerente_nome) {
            const g = [i.gerente_nome, i.gerente_celular && `cel ${i.gerente_celular}`, i.gerente_email].filter(Boolean);
            L.push(`Gerente: ${g.join(' · ')}`);
        }
        if (i.creci) L.push(`CRECI: ${i.creci}${i.validade_creci ? ` (validade ${i.validade_creci})` : ''}`);
        if (i.empreendimentos?.length) L.push(`Empreendimentos: ${i.empreendimentos.map(e => e.nome).join(', ')}`);
        L.push(`Origem do cadastro: ${i.origem === 'cv' ? 'direto no CV' : (i.origem === 'link' ? 'link público do Office' : 'tela do Office')}`);
        return L.join('\n');
    }).join('\n\n');
}

const STATUS_LABEL = {
    invite: 'Convite aguardando preenchimento',
    processing: 'Processando no CV',
    completed: 'Concluído',
    error: 'Erro na integração com o CV',
    revoked: 'Revogado',
};

function formatCadastroList(items) {
    return items.map((r, n) => {
        const L = [`[${n + 1}] ${r.label || r.form?.imobiliaria?.nome || 'Sem nome'} — ${STATUS_LABEL[r.status] || r.status}`];
        L.push(`Tipo: ${r.source === 'public' ? (r.multi_use ? 'link público multi-uso' : 'link público de uso único') : 'cadastro pela tela'}`);
        if (r.creator_name) L.push(`Criado por: ${r.creator_name}`);
        if (r.enterprises?.length) L.push(`Empreendimentos: ${r.enterprises.map(e => e.nome).join(', ')}`);
        if (r.status === 'invite' && r.token) L.push(`Link: ${LP_HOST}/imobiliaria/${r.token}`);
        if (r.multi_use) {
            const janela = [r.starts_at && `início ${fmtDate(r.starts_at)}`, r.ends_at && `fim ${fmtDate(r.ends_at)}`].filter(Boolean).join(', ');
            if (janela) L.push(`Janela: ${janela}`);
            L.push(`Submissões: ${(r.submissions || []).length}${(r.submissions || []).length ? ` (${(r.submissions || []).map(s => s.nome || s.cnpj).join('; ')})` : ''}`);
        }
        if (r.status === 'error' && r.error) L.push(`Erro: ${String(r.error).slice(0, 200)}`);
        if (r.completed_at) L.push(`Concluído em: ${fmtDate(r.completed_at)}`);
        return L.join('\n');
    }).join('\n\n');
}

// ── Cards p/ o FRONTEND (ChatImobiliariaCards.vue) ───────────────────────────
function imobiliariaCards(items) {
    return items.map((i) => ({
        kind: 'imobiliaria',
        title: i.nome,
        subtitle: i.razao_social && i.razao_social !== i.nome ? i.razao_social : null,
        cnpj: i.cnpj || null,
        sigla: i.sigla || null,
        ativo: i.ativo === 'S',
        origem: i.origem,
        cidades: i.cidades || [],
        creci: i.creci || null,
        validade_creci: i.validade_creci || null,
        contato: { email: i.email || null, telefone: i.telefone || null, celular: i.celular || null },
        gerente: i.gerente_nome
            ? { nome: i.gerente_nome, email: i.gerente_email || null, celular: i.gerente_celular || i.gerente_telefone || null }
            : null,
        empreendimentos: (i.empreendimentos || []).map(e => ({ id: e.id, nome: e.nome, cidade: e.cidade })),
        // Deep-link: abre a tela já filtrada nesta imobiliária (CNPJ é unívoco).
        link: `${SCREEN}?tab=imobiliarias&q=${encodeURIComponent(onlyDigits(i.cnpj) || i.nome)}`,
    }));
}

const STATUS_TONE = { invite: 'amber', processing: 'amber', completed: 'emerald', error: 'rose', revoked: 'slate' };

function cadastroCards(items) {
    return items.map((r) => ({
        kind: 'cadastro',
        title: r.label || r.form?.imobiliaria?.nome || 'Sem nome',
        status: r.status,
        statusLabel: STATUS_LABEL[r.status] || r.status,
        tone: STATUS_TONE[r.status] || 'slate',
        source: r.source,
        multiUse: !!r.multi_use,
        startsAt: r.starts_at || null,
        endsAt: r.ends_at || null,
        submissions: r.multi_use ? (r.submissions || []).length : null,
        enterprises: (r.enterprises || []).map(e => e.nome),
        inviteUrl: r.status === 'invite' && r.token ? `${LP_HOST}/imobiliaria/${r.token}` : null,
        creator: r.creator_name || null,
        completedAt: r.completed_at || null,
        link: `${SCREEN}?tab=cadastros`,
    }));
}

// ─── imobiliarias_search ─────────────────────────────────────────────────────
registerTool({
    name: 'imobiliarias_search',
    description: 'Consulta as IMOBILIÁRIAS PARCEIRAS cadastradas no CV: contatos (e-mail/telefone/celular), gerente responsável e contatos dele, empreendimentos vinculados, CRECI e validade, cidade, ativa/inativa e origem do cadastro. Use quando o usuário pergunta sobre uma imobiliária específica ("contato da X", "quem é o gerente da X"), quais imobiliárias atuam numa cidade/empreendimento, ou quantas parceiras existem. NUNCA invente nome, CNPJ ou contato de imobiliária — só afirme o que vier desta ferramenta.',
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Busca livre: nome da imobiliária, razão social, CNPJ ou nome do gerente.' },
            cidade: { type: 'string', description: 'Filtra por cidade de atuação (da imobiliária ou dos empreendimentos vinculados).' },
            empreendimento: { type: 'string', description: 'Filtra por nome do empreendimento vinculado.' },
            situacao: { type: 'string', enum: ['ativas', 'inativas', 'todas'], description: 'Padrão: "ativas".' },
        },
    },
    requiredPermissions: [],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const situacao = ['ativas', 'inativas', 'todas'].includes(args?.situacao) ? args.situacao : 'ativas';
        // Escopo de cidade p/ não-admin é aplicado DENTRO do report (mesma regra da tela).
        const { imobiliarias, last_sync } = await buildImobiliariasReport({
            user,
            q: args?.query || '',
            cidade: args?.cidade || '',
            empreendimento: args?.empreendimento || '',
        });

        let rows = imobiliarias;
        if (situacao === 'ativas') rows = rows.filter(i => i.ativo === 'S');
        if (situacao === 'inativas') rows = rows.filter(i => i.ativo !== 'S');

        const total = rows.length;
        const ativas = rows.filter(i => i.ativo === 'S').length;
        const shown = rows.slice(0, MAX_CARDS);

        const out = {
            total,
            ativas,
            exibidas: shown.length,
            ultima_sincronizacao: last_sync ? fmtDate(last_sync) : null,
            imobiliarias: formatImobiliariaList(shown),
            message: total
                ? `${total} imobiliária(s) no filtro (${shown.length} detalhada(s) no campo "imobiliarias"; cards JÁ estão na UI). Responda CURTO com o que foi perguntado (contato, gerente, total...) usando SOMENTE estes dados — nunca invente contato/CNPJ. Se a pergunta era um número/total, use ${total}. Para a lista completa, indique a tela ${SCREEN}.`
                : 'Nenhuma imobiliária encontrada nesse filtro (dentro do que o usuário pode ver). Diga isso com clareza — não invente. Sugira ajustar o filtro ou conferir a tela ' + SCREEN + '.',
        };
        if (shown.length) {
            out.type = 'imobiliaria_cards';
            out.title = 'Imobiliárias';
            out.cards = imobiliariaCards(shown);
            out.screenLink = `${SCREEN}?tab=imobiliarias`;
        }
        return { result: out, resultCount: total };
    },
});

// ─── imobiliarias_cadastros ──────────────────────────────────────────────────
registerTool({
    name: 'imobiliarias_cadastros',
    description: 'Acompanha os CADASTROS E CONVITES de imobiliárias feitos pelo Office: links públicos gerados (aguardando preenchimento, janela de link multi-uso, submissões), cadastros processando, concluídos ou com erro no CV. Use quando o usuário pergunta "o link que gerei foi preenchido?", "como está o cadastro da imobiliária X?", "tem cadastro com erro?", "quais convites estão pendentes?". Para cadastrar uma NOVA imobiliária ou gerar um novo link, oriente a usar a tela /comercial/imobiliarias (botões "Nova imobiliária" e "Gerar link") — esta ferramenta só CONSULTA.',
    parameters: {
        type: 'object',
        properties: {
            status: {
                type: 'string',
                enum: ['pendentes', 'convites', 'erros', 'concluidos', 'todos'],
                description: '"pendentes" = convites em aberto + processando + erros (padrão); "convites" = só links aguardando preenchimento; "erros" = só falhas de integração; "concluidos"; "todos".',
            },
            busca: { type: 'string', description: 'Nome/label da imobiliária ou CNPJ para localizar um cadastro específico.' },
        },
    },
    requiredPermissions: [],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const status = ['pendentes', 'convites', 'erros', 'concluidos', 'todos'].includes(args?.status) ? args.status : 'pendentes';
        const where = {};
        // Mesmo escopo da tela: não-admin vê só os cadastros que criou.
        if (user.role !== 'admin') where.created_by = user.id;

        const rowsDb = await db.RealEstateRegistration.findAll({
            where,
            include: db.User ? [{ model: db.User, as: 'creator', attributes: ['id', 'username'] }] : [],
            order: [['id', 'DESC']],
            limit: 300,
        });

        const busca = String(args?.busca || '').trim().toLowerCase();
        const buscaDigits = onlyDigits(busca);
        let rows = rowsDb.map(r => {
            const j = r.toJSON();
            return { ...j, creator_name: j.creator?.username || null };
        });

        if (status === 'convites') rows = rows.filter(r => r.status === 'invite');
        else if (status === 'erros') rows = rows.filter(r => r.status === 'error');
        else if (status === 'concluidos') rows = rows.filter(r => r.status === 'completed');
        else if (status === 'pendentes') rows = rows.filter(r => ['invite', 'processing', 'error'].includes(r.status));

        if (busca) {
            rows = rows.filter(r => {
                const nome = `${r.label || ''} ${r.form?.imobiliaria?.nome || ''} ${r.form?.gerente?.nome || ''}`.toLowerCase();
                const cnpj = onlyDigits(r.form?.imobiliaria?.cnpj || '');
                return nome.includes(busca) || (buscaDigits && cnpj.includes(buscaDigits));
            });
        }

        const total = rows.length;
        const shown = rows.slice(0, MAX_CARDS);
        const porStatus = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});

        const out = {
            total,
            por_status: Object.entries(porStatus).map(([s, n]) => `${STATUS_LABEL[s] || s}: ${n}`).join('; ') || null,
            cadastros: formatCadastroList(shown),
            message: total
                ? `${total} cadastro(s)/convite(s) no filtro (detalhes no campo "cadastros"; cards JÁ estão na UI). Responda CURTO e objetivo com base SOMENTE nestes dados. Se houver erro de integração, explique que dá para reprocessar na tela ${SCREEN} (aba Cadastros e convites). Nunca invente status ou link.`
                : 'Nenhum cadastro/convite nesse filtro (o usuário vê só os que ele criou, salvo admin). Diga isso com clareza. Para cadastrar ou gerar link: tela ' + SCREEN + '.',
        };
        if (shown.length) {
            out.type = 'imobiliaria_cards';
            out.title = 'Cadastros e convites de imobiliárias';
            out.cards = cadastroCards(shown);
            out.screenLink = `${SCREEN}?tab=cadastros`;
        }
        return { result: out, resultCount: total };
    },
});

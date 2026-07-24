// services/OfficeAI/ReportsTools.js
//
// Tools da Eme sobre os RELATÓRIOS DA EME (tela /relatorios):
//   - query_reports: lista os relatórios que o usuário PODE ver (próprios +
//     compartilhados com ele por usuário/cargo, já respeitando privado/publicado),
//     com um card de resumo (blocos, período, modo, visibilidade) e link p/ abrir.
//   - create_report: cria um RASCUNHO com o pedido do usuário (briefing) e devolve
//     o link do builder; ao abrir, o builder dispara o briefing como 1ª mensagem
//     e a Eme monta os blocos lá (aqui no chat NÃO se monta relatório).
//
// Visibilidade: reutiliza listForUser(user) do ReportService — fonte única da
// regra (admin vê tudo; dono vê os seus; internos/públicos por acesso; privados só
// do dono). query_reports NÃO é adminOnly (relatórios têm audiência);
// create_report É adminOnly — mesma alçada do POST /reports.

import { registerTool } from './ToolRegistry.js';
import db from '../../models/sequelize/index.js';
import { listForUser, publicExposureSummary } from '../emeReports/ReportService.js';

const MAX_CARDS = 8;
const normText = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const VIS_LABEL = { public: 'Público', internal: 'Interno', private: 'Privado' };
const fmtDate = (d) => { try { return d ? new Date(d).toLocaleDateString('pt-BR') : null; } catch { return null; } };

function periodoTxt(r) {
    if (!r.periodStart && !r.periodEnd) return null;
    const a = fmtDate(r.periodStart);
    const b = r.periodEnd ? fmtDate(r.periodEnd) : 'hoje';
    return a ? `${a} a ${b}` : null;
}

// Link: publicado → visualização; rascunho (dono/admin) → builder.
const linkFor = (r) => r.status === 'published' ? `/relatorios/${r.id}/view` : `/relatorios/${r.id}`;

function reportCard(r, origem) {
    const resumo = publicExposureSummary(r);
    return {
        id: r.id,
        title: r.title,
        empreendimento: r.enterpriseName || null,
        status: r.status,              // draft | published
        visibilidade: r.visibility,    // private | internal | public
        modo: r.dataMode,              // fixed | live
        blocos: resumo.blockCount || 0,
        secoes: resumo.sections || [],
        fontes: resumo.dataSources || [],
        periodo: periodoTxt(r),
        dono: r.owner?.username || null,
        atualizado: fmtDate(r.updatedAt || r.updated_at),
        origem,                        // 'meu' | 'compartilhado'
        link: linkFor(r),
    };
}

function formatReportList(cards) {
    return cards.map((c, n) => {
        const L = [`[${n + 1}] ${c.title}${c.status === 'published' ? '' : ' (rascunho)'} — ${VIS_LABEL[c.visibilidade] || c.visibilidade} · ${c.modo === 'live' ? 'ao vivo' : 'fixo'}`];
        if (c.empreendimento) L.push(`Empreendimento: ${c.empreendimento}`);
        if (c.periodo) L.push(`Período: ${c.periodo}`);
        L.push(`${c.blocos} bloco(s)${c.secoes.length ? ` · seções: ${c.secoes.slice(0, 4).join(', ')}` : ''}`);
        if (c.origem === 'compartilhado' && c.dono) L.push(`Compartilhado por: ${c.dono}`);
        return L.join('\n');
    }).join('\n\n');
}

registerTool({
    name: 'query_reports',
    description: 'Lista os RELATÓRIOS (da Eme, tela /relatorios) que o usuário pode ver: os próprios e os compartilhados com ele (por usuário ou cargo). Cada resultado traz um card com resumo (empreendimento, período, nº de blocos/seções, modo fixo/ao vivo, visibilidade) e link para abrir sem entrar na tela. Use quando o usuário perguntar "quais relatórios eu tenho", "meus relatórios", "tem relatório de <empreendimento/tema>?", "relatórios compartilhados comigo". NUNCA invente relatório — só cite os que esta ferramenta retornar.',
    parameters: {
        type: 'object',
        properties: {
            busca: { type: 'string', description: 'Filtra por título ou empreendimento (busca parcial, sem acento).' },
            escopo: { type: 'string', enum: ['todos', 'meus', 'compartilhados'], description: '"meus" = só os que sou dono; "compartilhados" = só os que outros compartilharam comigo. Padrão: todos.' },
        },
    },
    requiredPermissions: [],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const { own, shared } = await listForUser(user);
        const escopo = ['todos', 'meus', 'compartilhados'].includes(args?.escopo) ? args.escopo : 'todos';

        let cards = [];
        if (escopo !== 'compartilhados') cards.push(...own.map(r => reportCard(r.get ? r.get({ plain: true }) : r, 'meu')));
        if (escopo !== 'meus') cards.push(...shared.map(r => reportCard(r.get ? r.get({ plain: true }) : r, 'compartilhado')));

        const busca = normText(args?.busca);
        if (busca) cards = cards.filter(c => normText(c.title).includes(busca) || normText(c.empreendimento).includes(busca));

        const total = cards.length;
        const shown = cards.slice(0, MAX_CARDS);

        const out = {
            total,
            relatorios: formatReportList(shown),
            message: total
                ? `${total} relatório(s) visível(is) ao usuário${busca ? ` para "${args.busca}"` : ''} (${shown.length} no card; a UI JÁ mostra os cards com resumo e botão de abrir). Responda CURTO indicando o(s) relevante(s) — NUNCA invente título/conteúdo. Para abrir, o usuário clica no card ou vai em /relatorios.`
                : `Nenhum relatório ${busca ? `bate com "${args.busca}"` : 'disponível para o usuário'}. Diga isso com clareza — não invente. Relatórios são criados/compartilhados na tela /relatorios.`,
        };
        if (shown.length) {
            out.type = 'report_cards';
            out.title = 'Relatórios';
            out.cards = shown;
            out.screenLink = '/relatorios';
        }
        return { result: out, resultCount: total };
    },
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const cleanDate = (v) => (DATE_RE.test(String(v || '').trim()) ? String(v).trim() : null);

registerTool({
    name: 'create_report',
    description: 'CRIA um relatório da Eme (sistema de Relatórios, tela /relatorios) como rascunho e devolve o card com link do builder, onde a Eme monta os blocos automaticamente a partir do pedido. Use SEMPRE que o usuário pedir para criar/montar/gerar/salvar um relatório com dados do sistema (funil de leads, pré-cadastros, reservas, conversão, comparativos, por empreendimento/período) — ex.: "cria um relatório disso", "quero um relatório no meu sistema de relatórios", "monta um relatório comparativo". NÃO confundir com relatório de EVENTOS (query_events) nem com abrir uma tela existente (navigate_to_page). Em briefing, passe o pedido COMPLETO do usuário (métricas, empreendimento, período, comparações desejadas) — é ele que a Eme do builder vai executar.',
    parameters: {
        type: 'object',
        properties: {
            titulo: { type: 'string', description: 'Título curto do relatório (ex.: "Funil de Vendas - Residencial Ingá").' },
            empreendimento: { type: 'string', description: 'Empreendimento principal, se o pedido for de um específico.' },
            briefing: { type: 'string', description: 'O pedido completo do usuário, com todas as métricas/comparações/período que o relatório deve conter. Será executado pela Eme dentro do builder.' },
            periodo_inicio: { type: 'string', description: 'Início do período AAAA-MM-DD (opcional).' },
            periodo_fim: { type: 'string', description: 'Fim do período AAAA-MM-DD; omita para "até hoje" (opcional).' },
            modo: { type: 'string', enum: ['fixed', 'live'], description: '"live" quando o usuário quiser acompanhar dados atualizados; padrão "fixed" (dados congelados).' },
        },
        required: ['briefing'],
    },
    adminOnly: true,
    contexts: ['OFFICE'],
    async handler(user, args) {
        const briefing = String(args?.briefing || '').trim().slice(0, 4000);
        if (!briefing) {
            return { result: { error: 'Briefing vazio — descreva o que o relatório deve conter.' } };
        }
        const report = await db.EmeGeneratedReport.create({
            ownerId: user.id,
            title: String(args?.titulo || 'Novo relatório').trim().slice(0, 200) || 'Novo relatório',
            enterpriseName: args?.empreendimento ? String(args.empreendimento).trim().slice(0, 200) : null,
            dataMode: args?.modo === 'live' ? 'live' : 'fixed',
            periodStart: cleanDate(args?.periodo_inicio),
            periodEnd: cleanDate(args?.periodo_fim),
            briefing,
        });

        const card = reportCard(report.get({ plain: true }), 'meu');
        return {
            result: {
                type: 'report_cards',
                title: 'Relatório criado',
                cards: [card],
                screenLink: '/relatorios',
                message: `Rascunho "${report.title}" criado. A UI JÁ mostra o card com botão Abrir: ao abrir, a Eme do builder monta o relatório automaticamente a partir do pedido. Responda CURTO confirmando a criação e orientando a clicar em Abrir — NÃO invente blocos, números nem conteúdo do relatório aqui no chat.`,
            },
            resultIds: [report.id],
            resultCount: 1,
        };
    },
});

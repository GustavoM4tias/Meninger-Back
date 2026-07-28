// services/OfficeAI/FinanceTools.js
//
// Tools da Eme sobre o FINANCEIRO:
//   - query_custos:  custos da tela /financeiro/custos (ao vivo do backup Sienge),
//                    com a MESMA alçada da tela (requiredPermissions) e a MESMA
//                    cascata de Visibilidade de Departamentos (dentro do service).
//   - query_boletos: histórico/estatísticas dos boletos Caixa (tela admin-only,
//                    tool admin-only).
//
// Princípios (iguais ao resto do registry):
//   - Segurança DENTRO do handler com base em `user` (nunca em args).
//   - Dados internos → contexts: ['OFFICE'] apenas.
//   - Texto p/ o modelo em campos string; rows/labels volumosos são cortados pelo
//     summarizeForGemini e chegam só ao frontend (ChatTable/ChatChart).

import dayjs from 'dayjs';
import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { registerTool } from './ToolRegistry.js';
import ExpenseService from '../expenseService.js';

const expenseService = new ExpenseService();

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtMoney = (v) => BRL.format(Number(v || 0));
const fmtDate = (d) => { try { return d ? dayjs(d).format('DD/MM/YYYY') : null; } catch { return null; } };

// Janela padrão: mês corrente. Aceita 'YYYY-MM-DD'; 'YYYY-MM' vira o mês inteiro.
function resolvePeriod(args) {
    let start = String(args?.data_inicio || '').trim();
    let end = String(args?.data_fim || '').trim();
    if (/^\d{4}-\d{2}$/.test(start)) { end = end || dayjs(`${start}-01`).endOf('month').format('YYYY-MM-DD'); start = `${start}-01`; }
    if (/^\d{4}-\d{2}$/.test(end)) end = dayjs(`${end}-01`).endOf('month').format('YYYY-MM-DD');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) start = dayjs().startOf('month').format('YYYY-MM-DD');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) end = dayjs().endOf('month').format('YYYY-MM-DD');
    if (end < start) [start, end] = [end, start];
    return { start, end };
}

// ─── query_custos ────────────────────────────────────────────────────────────
registerTool({
    name: 'query_custos',
    description: 'Consulta os CUSTOS FINANCEIROS pagos (parcelas efetivamente pagas, ao vivo do Sienge — mesma fonte da tela /financeiro/custos): total do período, quebra por empreendimento (centro de custo) ou por departamento, e detalhe das parcelas de um empreendimento. Use quando o usuário perguntar "quanto gastamos", "quanto foi pago", "maiores custos/despesas do mês", "custos por departamento". NÃO use para "Custos Menin × Cliente" / custos de VENDA de um produto (comissão, ITBI, cartório, CCA, documentação repassada ao cliente) — isso é da Ficha Comercial (get_condition_sheet). Regra prática: pergunta sobre DESPESA PAGA/orçamento → aqui; pergunta sobre o que compõe a condição comercial de um empreendimento → ficha. O usuário só enxerga os departamentos que a alçada dele permite (regra aplicada automaticamente). Período padrão: mês atual.',
    parameters: {
        type: 'object',
        properties: {
            data_inicio: { type: 'string', description: 'Início do período (YYYY-MM-DD ou YYYY-MM). Padrão: início do mês atual.' },
            data_fim: { type: 'string', description: 'Fim do período (YYYY-MM-DD ou YYYY-MM). Padrão: fim do mês atual.' },
            empreendimento: { type: 'string', description: 'Nome (ou parte do nome) do empreendimento/centro de custo para focar a consulta.' },
            agrupar: { type: 'string', enum: ['empreendimento', 'departamento'], description: 'Gera gráfico com a quebra pedida. Sem agrupar + com empreendimento → tabela com as parcelas.' },
        },
    },
    requiredPermissions: ['/financeiro/custos'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const { start, end } = resolvePeriod(args);
        // Visibilidade de departamentos (cascata global→cargo→usuário) é aplicada
        // DENTRO do summarizeAllMonth com base no user — mesma regra da tela.
        const summary = await expenseService.summarizeAllMonth({ startDate: start, endDate: end, user });

        let groups = summary.groups;
        const filtro = String(args?.empreendimento || '').trim().toLowerCase();
        if (filtro) {
            groups = groups.filter(g =>
                String(g.costCenterName || '').toLowerCase().includes(filtro) ||
                String(g.costCenterId) === filtro
            );
        }

        const expenses = groups.flatMap(g => g.expenses);
        const total = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
        const periodoTxt = `${fmtDate(start)} a ${fmtDate(end)}`;

        if (!expenses.length) {
            return {
                result: {
                    total: 0,
                    message: `Nenhum custo encontrado no período ${periodoTxt}${filtro ? ` para "${args.empreendimento}"` : ''} (dentro do que o usuário pode ver). Diga isso com clareza — não invente valores. A tela completa é /financeiro/custos.`,
                },
                resultCount: 0,
            };
        }

        const agrupar = ['empreendimento', 'departamento'].includes(args?.agrupar) ? args.agrupar : null;

        // Quebra pedida (ou padrão por empreendimento quando não há filtro focado)
        const keyOf = {
            empreendimento: (e) => e.costCenterName || `CC ${e.costCenterId}`,
            departamento: (e) => e.departmentName || 'Sem departamento',
        }[agrupar || 'empreendimento'];

        const byKey = new Map();
        for (const e of expenses) {
            const k = keyOf(e);
            byKey.set(k, (byKey.get(k) || 0) + Number(e.amount || 0));
        }
        const sorted = [...byKey.entries()].sort((a, b) => b[1] - a[1]);
        const topText = sorted.slice(0, 10).map(([k, v], i) => `[${i + 1}] ${k}: ${fmtMoney(v)}`).join('\n');

        const out = {
            periodo: periodoTxt,
            total,
            total_formatado: fmtMoney(total),
            parcelas: expenses.length,
            quebra: topText,
            message: `Custos de ${periodoTxt}${filtro ? ` — filtro "${args.empreendimento}"` : ''}: TOTAL ${fmtMoney(total)} em ${expenses.length} parcela(s). Quebra por ${agrupar || 'empreendimento'} no campo "quebra" (top 10; o gráfico/tabela JÁ está na UI). Responda CURTO com os valores pedidos usando SOMENTE estes dados — nunca invente valor. Tela completa: /financeiro/custos.`,
        };

        if (filtro && !agrupar) {
            // Detalhe: tabela das parcelas do(s) empreendimento(s) filtrado(s)
            const rows = expenses
                .sort((a, b) => Number(b.amount) - Number(a.amount))
                .slice(0, 30)
                .map(e => ({
                    fornecedor: e.bill?.creditor_json?.tradeName || e.bill?.creditor_json?.name || e.bill?.document_number || `Título ${e.billId}`,
                    departamento: e.departmentName || '-',
                    pagamento: fmtDate(e.paidAt || e.dueDate) || '-',
                    valor: fmtMoney(e.amount),
                }));
            out.type = 'table';
            out.title = `Custos — ${groups.map(g => g.costCenterName || g.costCenterId).slice(0, 3).join(', ')}`;
            out.subtitle = `${periodoTxt} · ${expenses.length} parcela(s) · Total ${fmtMoney(total)}`;
            out.columns = [
                { key: 'fornecedor', label: 'Fornecedor/Título' },
                { key: 'departamento', label: 'Departamento' },
                { key: 'pagamento', label: 'Pagamento' },
                { key: 'valor', label: 'Valor', type: 'currency' },
            ];
            out.rows = rows;
            out.total = expenses.length;
        } else {
            out.type = 'chart';
            out.chartType = 'bar';
            out.title = `Custos por ${agrupar || 'empreendimento'}`;
            out.subtitle = `${periodoTxt} · Total ${fmtMoney(total)}`;
            out.labels = sorted.slice(0, 15).map(([k]) => k);
            out.data = sorted.slice(0, 15).map(([, v]) => Number(v.toFixed(2)));
        }
        return { result: out, resultCount: expenses.length, filtersApplied: { data_inicio: start, data_fim: end, empreendimento: filtro || undefined, agrupar: agrupar || undefined } };
    },
});

// ─── query_boletos ───────────────────────────────────────────────────────────
const BOLETO_STATUS_LABEL = { processing: 'Processando', success: 'Emitido', error: 'Erro', skipped: 'Ignorado' };
const PAYMENT_LABEL = { pending: 'Aguardando pagamento', paid: 'Pago', cancelled: 'Cancelado', error: 'Erro na consulta' };

registerTool({
    name: 'query_boletos',
    description: 'Consulta o histórico de BOLETOS CAIXA (ato) emitidos automaticamente a partir das reservas do CV — mesma fonte da tela /financeiro/boleto-caixa: quantos foram emitidos, com erro, pagos, aguardando pagamento ou cancelados; valores; boletos de uma reserva/titular/empreendimento. Use quando o usuário perguntar sobre boletos ("quantos boletos", "boletos pagos", "boleto da reserva X", "boletos com erro"). Ferramenta restrita a administradores.',
    parameters: {
        type: 'object',
        properties: {
            data_inicio: { type: 'string', description: 'Início do período de emissão (YYYY-MM-DD ou YYYY-MM). Padrão: mês atual.' },
            data_fim: { type: 'string', description: 'Fim do período (YYYY-MM-DD ou YYYY-MM).' },
            status: { type: 'string', enum: ['success', 'error', 'processing', 'skipped', 'todos'], description: 'Status da EMISSÃO. Padrão: todos.' },
            situacao_pagamento: { type: 'string', enum: ['paid', 'pending', 'cancelled', 'error', 'todos'], description: 'Situação do PAGAMENTO. Padrão: todas.' },
            empreendimento: { type: 'string', description: 'Filtra por nome (ou parte) do empreendimento.' },
            busca: { type: 'string', description: 'Nome do titular ou número da reserva.' },
        },
    },
    adminOnly: true,
    contexts: ['OFFICE'],
    async handler(user, args) {
        const { start, end } = resolvePeriod(args);
        const where = {
            created_at: { [Op.between]: [`${start} 00:00:00`, `${end} 23:59:59`] },
            ignorado: { [Op.or]: [false, null] },
        };
        if (['success', 'error', 'processing', 'skipped'].includes(args?.status)) where.status = args.status;
        if (['paid', 'pending', 'cancelled', 'error'].includes(args?.situacao_pagamento)) where.payment_status = args.situacao_pagamento;
        if (args?.empreendimento) where.empreendimento = { [Op.iLike]: `%${String(args.empreendimento).trim()}%` };
        const busca = String(args?.busca || '').trim();
        if (busca) {
            where[Op.or] = [
                { titular_nome: { [Op.iLike]: `%${busca}%` } },
                ...(/^\d+$/.test(busca) ? [{ idreserva: busca }] : []),
            ];
        }

        const rows = await db.BoletoHistory.findAll({ where, order: [['created_at', 'DESC']], limit: 2000, raw: true });

        const periodoTxt = `${fmtDate(start)} a ${fmtDate(end)}`;
        if (!rows.length) {
            return {
                result: { total: 0, message: `Nenhum boleto no filtro (emissão ${periodoTxt}). Diga isso com clareza — não invente. Tela completa: /financeiro/boleto-caixa.` },
                resultCount: 0,
            };
        }

        const count = (fn) => rows.filter(fn).length;
        const emitidos = count(r => r.status === 'success');
        const pagos = count(r => r.payment_status === 'paid');
        const valorEmitido = rows.filter(r => r.status === 'success').reduce((s, r) => s + Number(r.valor || 0), 0);
        const valorPago = rows.filter(r => r.payment_status === 'paid').reduce((s, r) => s + Number(r.valor || 0), 0);

        const resumo = [
            `Total no filtro: ${rows.length}`,
            `Emitidos com sucesso: ${emitidos} (${fmtMoney(valorEmitido)})`,
            `Pagos: ${pagos} (${fmtMoney(valorPago)})`,
            `Aguardando pagamento: ${count(r => r.status === 'success' && r.payment_status === 'pending')}`,
            `Cancelados: ${count(r => r.payment_status === 'cancelled')}`,
            `Erro na emissão: ${count(r => r.status === 'error')}`,
        ].join('\n');

        const recentes = rows.slice(0, 8).map((r, i) =>
            `[${i + 1}] Reserva ${r.idreserva} — ${r.titular_nome || 'sem titular'} — ${r.empreendimento || '-'} — ${fmtMoney(r.valor)} — emissão: ${BOLETO_STATUS_LABEL[r.status] || r.status}${r.status === 'error' && r.error_message ? ` (${String(r.error_message).slice(0, 120)})` : ''} — pagamento: ${PAYMENT_LABEL[r.payment_status] || r.payment_status || '-'}${r.vencimento ? ` — venc. ${fmtDate(r.vencimento)}` : ''}`
        ).join('\n');

        return {
            result: {
                periodo: periodoTxt,
                resumo,
                recentes,
                type: 'table',
                title: 'Boletos Caixa',
                subtitle: `Emissão ${periodoTxt} · ${rows.length} boleto(s)`,
                columns: [
                    { key: 'reserva', label: 'Reserva' },
                    { key: 'titular', label: 'Titular' },
                    { key: 'empreendimento', label: 'Empreendimento' },
                    { key: 'valor', label: 'Valor', type: 'currency' },
                    { key: 'vencimento', label: 'Vencimento' },
                    { key: 'emissao', label: 'Emissão' },
                    { key: 'pagamento', label: 'Pagamento' },
                ],
                rows: rows.slice(0, 20).map(r => ({
                    reserva: r.idreserva,
                    titular: r.titular_nome || '-',
                    empreendimento: r.empreendimento || '-',
                    valor: fmtMoney(r.valor),
                    vencimento: fmtDate(r.vencimento) || '-',
                    emissao: BOLETO_STATUS_LABEL[r.status] || r.status,
                    pagamento: PAYMENT_LABEL[r.payment_status] || r.payment_status || '-',
                })),
                total: rows.length,
                message: `${rows.length} boleto(s) no filtro (emissão ${periodoTxt}). Números agregados no campo "resumo", últimos boletos no campo "recentes" (a tabela JÁ está na UI). Responda CURTO usando SOMENTE estes dados — nunca invente valor, reserva ou status. Ações (2ª via, reprocessar, marcar cancelado) são feitas na tela /financeiro/boleto-caixa.`,
            },
            resultCount: rows.length,
        };
    },
});

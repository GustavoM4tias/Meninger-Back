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
import { allowedEnterpriseNames, applyEnterpriseScope } from '../boleto/boletoScope.js';

const BOLETO_SCREEN = '/financeiro/boleto-caixa';
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

// ── Análise de MOMENTO DO PAGAMENTO ──────────────────────────────────────────
// Mede a diferença, em dias, entre a detecção do pagamento (`paid_at`) e o
// vencimento do boleto. Sem isso a Eme não conseguia responder "quantos
// anteciparam / pagaram em dia / pagaram depois" — a tool devolvia só contagens
// por status, e o prompt do modo Relatório proíbe estimar número.
//
// RESSALVA QUE VIAJA JUNTO COM O DADO: `paid_at` é o instante em que a
// verificação diária (08h) encontrou o título liquidado, NÃO a data real do
// pagamento no portal. Por isso quem paga no dia do vencimento aparece em D+1 —
// o bucket `no_vencimento_detectado_d1` existe exatamente pra não contar essa
// gente como atraso. A ressalva vai no texto devolvido ao modelo pra que ele
// nunca apresente D+1 como inadimplência.
const TIMING_BUCKETS = [
    { key: 'antecipado', label: 'Antecipado (2+ dias antes)', test: (d) => d <= -2 },
    { key: 'vespera', label: 'Véspera (1 dia antes)', test: (d) => d === -1 },
    { key: 'no_dia', label: 'No dia do vencimento', test: (d) => d === 0 },
    { key: 'no_vencimento_detectado_d1', label: 'Pagou no vencimento (detectado no dia seguinte)', test: (d) => d === 1 },
    { key: 'apos_vencimento', label: 'Após o vencimento (2+ dias)', test: (d) => d >= 2 },
];

const diffDiasVencimento = (paidAt, vencimento) => {
    if (!paidAt || !vencimento) return null;
    const pago = dayjs(paidAt).startOf('day');
    const venc = dayjs(String(vencimento).slice(0, 10)).startOf('day');
    if (!pago.isValid() || !venc.isValid()) return null;
    return pago.diff(venc, 'day');
};

function analisarMomentoPagamento(rows) {
    const pagos = rows
        .filter(r => r.status === 'success' && r.payment_status === 'paid' && r.paid_at && r.vencimento)
        .map(r => ({ ...r, dias: diffDiasVencimento(r.paid_at, r.vencimento) }))
        .filter(r => r.dias !== null);

    if (!pagos.length) return null;

    const total = pagos.length;
    const share = (n) => Number(((n / total) * 100).toFixed(1));

    const buckets = TIMING_BUCKETS.map(b => {
        const lista = pagos.filter(r => b.test(r.dias));
        return {
            chave: b.key, faixa: b.label, quantidade: lista.length, percentual: share(lista.length),
            valor: lista.reduce((s, r) => s + Number(r.valor || 0), 0),
        };
    });

    // Antecipação: só quem pagou ANTES (dias < 0).
    const antec = pagos.filter(r => r.dias < 0).map(r => Math.abs(r.dias)).sort((a, b) => a - b);
    const antecipacao = antec.length ? {
        quantidade: antec.length,
        percentual: share(antec.length),
        media_dias: Number((antec.reduce((a, b) => a + b, 0) / antec.length).toFixed(1)),
        mediana_dias: antec[Math.floor(antec.length / 2)],
        maior_antecedencia_dias: antec[antec.length - 1],
        faixas: [
            { faixa: '1 dia', quantidade: antec.filter(d => d === 1).length },
            { faixa: '2 a 3 dias', quantidade: antec.filter(d => d >= 2 && d <= 3).length },
            { faixa: '4 a 7 dias', quantidade: antec.filter(d => d >= 4 && d <= 7).length },
            { faixa: '8+ dias', quantidade: antec.filter(d => d >= 8).length },
        ],
    } : null;

    // Distribuição exata por dia (alimenta gráfico de barras).
    const porDiaMap = new Map();
    for (const r of pagos) porDiaMap.set(r.dias, (porDiaMap.get(r.dias) || 0) + 1);
    const distribuicao_por_dia = [...porDiaMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([dias, quantidade]) => ({ dias, quantidade }));

    const agrupar = (keyFn) => {
        const m = new Map();
        for (const r of pagos) {
            const k = keyFn(r) || '(não informado)';
            if (!m.has(k)) m.set(k, []);
            m.get(k).push(r);
        }
        return [...m.entries()].map(([chave, lista]) => {
            const linha = { chave, pagos: lista.length };
            for (const b of TIMING_BUCKETS) linha[b.key] = lista.filter(r => b.test(r.dias)).length;
            linha.media_dias = Number((lista.reduce((s, r) => s + r.dias, 0) / lista.length).toFixed(1));
            linha.valor = lista.reduce((s, r) => s + Number(r.valor || 0), 0);
            return linha;
        }).sort((a, b) => b.pagos - a.pagos);
    };

    const todosDias = pagos.map(r => r.dias).sort((a, b) => a - b);
    const media_geral = Number((todosDias.reduce((a, b) => a + b, 0) / total).toFixed(1));

    const resumoTxt = buckets
        .map(b => `${b.faixa}: ${b.quantidade} (${b.percentual}%)`)
        .join('\n');

    return {
        total_pagos_analisados: total,
        buckets,
        antecipacao,
        distribuicao_por_dia,
        por_mes_pagamento: agrupar(r => dayjs(r.paid_at).format('YYYY-MM')),
        por_empreendimento: agrupar(r => r.empreendimento),
        media_geral_dias: media_geral,
        mediana_geral_dias: todosDias[Math.floor(total / 2)],
        resumo: resumoTxt,
        ressalva: 'IMPORTANTE: a data usada é a da DETECÇÃO automática (verificação diária às 08h), não a data real do pagamento no portal da Caixa. Por isso quem paga no dia do vencimento só é visto na manhã seguinte: o bucket "no_vencimento_detectado_d1" é pagamento EM DIA e NUNCA deve ser apresentado como atraso. Some-o a "no_dia" para falar de pontualidade. Sempre cite esta limitação no relatório.',
    };
}

registerTool({
    name: 'query_boletos',
    description: 'Consulta o histórico de BOLETOS CAIXA (ato) emitidos automaticamente a partir das reservas do CV — mesma fonte da tela /financeiro/boleto-caixa: quantos foram emitidos, com erro, pagos, aguardando pagamento ou cancelados; valores; boletos de uma reserva/titular/empreendimento. Use quando o usuário perguntar sobre boletos ("quantos boletos", "boletos pagos", "boleto da reserva X", "boletos com erro"). Com analise_momento_pagamento=true, devolve também QUANDO os clientes pagam em relação ao vencimento (antecipado, véspera, no dia, após), com distribuição por dia, por mês e por empreendimento — use pra perguntas de pontualidade ("quantos anteciparam", "pagam em dia?", "quantos dias antes"). Só enxerga os empreendimentos liberados ao usuário.',
    parameters: {
        type: 'object',
        properties: {
            data_inicio: { type: 'string', description: 'Início do período de emissão (YYYY-MM-DD ou YYYY-MM). Padrão: mês atual.' },
            data_fim: { type: 'string', description: 'Fim do período (YYYY-MM-DD ou YYYY-MM).' },
            status: { type: 'string', enum: ['success', 'error', 'processing', 'skipped', 'todos'], description: 'Status da EMISSÃO. Padrão: todos.' },
            situacao_pagamento: { type: 'string', enum: ['paid', 'pending', 'cancelled', 'error', 'todos'], description: 'Situação do PAGAMENTO. Padrão: todas.' },
            empreendimento: { type: 'string', description: 'Filtra por nome (ou parte) do empreendimento.' },
            busca: { type: 'string', description: 'Nome do titular ou número da reserva.' },
            analise_momento_pagamento: { type: 'boolean', description: 'Se true, inclui a análise de QUANDO o cliente pagou em relação ao vencimento (antecipado/véspera/no dia/após), com médias, distribuição por dia, por mês e por empreendimento. Use pra perguntas de pontualidade e antecipação.' },
        },
    },
    // Mesma alçada e MESMO recorte da tela (2026-08-19): a tool nunca pode
    // entregar por chat o que a tela não entrega.
    requiredPermissions: [BOLETO_SCREEN],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const { start, end } = resolvePeriod(args);
        const where = {
            created_at: { [Op.between]: [`${start} 00:00:00`, `${end} 23:59:59`] },
            ignorado: { [Op.or]: [false, null] },
        };
        applyEnterpriseScope(where, await allowedEnterpriseNames(user), Op);
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

        // Análise de momento do pagamento (opt-in — evita inflar o payload das
        // consultas comuns, que só querem contagem por status).
        const momentoPagamento = args?.analise_momento_pagamento === true
            ? analisarMomentoPagamento(rows)
            : null;

        return {
            result: {
                periodo: periodoTxt,
                resumo,
                recentes,
                ...(momentoPagamento
                    ? { momento_pagamento: momentoPagamento }
                    : {}),
                ...(args?.analise_momento_pagamento === true && !momentoPagamento
                    ? { momento_pagamento_indisponivel: 'Nenhum boleto PAGO com data de pagamento e vencimento no filtro — não há como analisar pontualidade. Diga isso; não estime.' }
                    : {}),
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

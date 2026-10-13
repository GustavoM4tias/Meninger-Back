// services/cobrancaAto/resumoEmailService.js
//
// Resumo da Cobrança do Ato por e-mail: os MESMOS números dos cartões da tela,
// com os MESMOS filtros, mais o que os cartões não dizem sozinhos - quanto do
// "a receber" já venceu, o que entrou de caixa no período e o retrato por
// empreendimento. Quem envia é a pessoa, pelo botão da tela; o escopo de
// empreendimentos é o dela (historicoService já recorta).
import Historico from './historicoService.js';
import { sendEmail } from '../../email/email.service.js';

const OFFICE_URL = process.env.FRONTEND_URL || 'https://office.menin.com.br';
const MAX_DESTINATARIOS = 20;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const brl = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1).replace('.', ',')}%` : '0%');
const diaBr = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');
const isoDe = (v) => (v instanceof Date ? v.toISOString() : String(v || '')).slice(0, 10);

/** Hoje em Brasília (YYYY-MM-DD): o vencimento é data local, não UTC. */
function hojeBrasilia() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

/**
 * Mesma classificação dos cartões (historicoService.estatisticas): erro de
 * reserva morta e baixado de reserva morta saem da conta de trabalho/evasão.
 */
function balde(r) {
    if (r.status === 'error') return r.reserva_morta ? 'encerrado' : 'erro';
    if (r.status !== 'success') return null;
    const ps = r.payment_status || 'pending';
    if ((ps === 'cancelled' || ps === 'expired') && r.reserva_morta) return 'encerrado';
    if (ps === 'paid') return 'pago';
    if (ps === 'cancelled' || ps === 'expired' || ps === 'denied') return 'evasao';
    if (ps === 'refunded') return 'estornado';
    return 'pendente';
}

export async function montarResumo(user, filtros = {}) {
    const base = { ...filtros, page: undefined, limit: 'all', sortBy: undefined, sortDir: undefined };
    const temPeriodo = !!(filtros.dateFrom || filtros.dateTo);

    const [stats, lista, entradas] = await Promise.all([
        Historico.estatisticas(user, base),
        Historico.listar(user, base),
        // Caixa do período: pago entre as datas do filtro, venha de que emissão
        // vier (boleto de setembro pago em outubro entra em outubro).
        temPeriodo
            ? Historico.estatisticas(user, {
                ...base, dateFrom: undefined, dateTo: undefined, dateField: undefined,
                paidFrom: filtros.dateFrom, paidTo: filtros.dateTo,
                status: undefined, paymentStatus: undefined,
            })
            : null,
    ]);

    const hoje = hojeBrasilia();
    const vencidos = [];
    const porEmp = new Map();
    let aVencer = { qty: 0, valor: 0 };
    let vencidosTot = { qty: 0, valor: 0 };

    for (const r of lista.rows) {
        const b = balde(r);
        if (!b) continue;
        const valor = Number(r.valor) || 0;
        const nome = r.empreendimento || 'Sem empreendimento';
        if (!porEmp.has(nome)) porEmp.set(nome, { nome, emitidos: 0, pagos: 0, pendente: 0, evasao: 0, qEvasao: 0, qEmitidos: 0 });
        const e = porEmp.get(nome);
        if (r.status === 'success') { e.emitidos += valor; e.qEmitidos += 1; }
        if (b === 'pago') e.pagos += valor;
        if (b === 'pendente') {
            e.pendente += valor;
            const venc = isoDe(r.vencimento);
            if (venc && venc < hoje) {
                vencidosTot = { qty: vencidosTot.qty + 1, valor: vencidosTot.valor + valor };
                vencidos.push({
                    reserva: r.idreserva, titular: r.titular_nome, empreendimento: nome,
                    valor: brl(valor), vencimento: diaBr(venc),
                });
            } else {
                aVencer = { qty: aVencer.qty + 1, valor: aVencer.valor + valor };
            }
        }
        if (b === 'evasao') { e.evasao += valor; e.qEvasao += 1; }
    }

    const erros = lista.rows
        .filter(r => balde(r) === 'erro')
        .map(r => ({
            reserva: r.idreserva, titular: r.titular_nome, empreendimento: r.empreendimento || '',
            valor: brl(r.valor), motivo: String(r.error_message || '').split('\n')[0].slice(0, 140),
        }));

    const emitidos = stats.emitidos.qty;
    const evasao = { qty: stats.cancelados.qty + stats.expirados.qty + stats.negados.qty,
        valor: stats.cancelados.valor + stats.expirados.valor + stats.negados.valor };

    const periodo = temPeriodo
        ? `${diaBr(filtros.dateFrom) || 'início'} a ${diaBr(filtros.dateTo) || 'hoje'}`
        : 'todo o histórico';

    return {
        periodo,
        geradoEm: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
        emitidos: { qty: emitidos, valor: brl(stats.emitidos.valor) },
        pagos: { qty: stats.pagos.qty, valor: brl(stats.pagos.valor), pct: pct(stats.pagos.qty, emitidos) },
        aReceber: { qty: stats.pendentes.qty, valor: brl(stats.pendentes.valor), pct: pct(stats.pendentes.qty, emitidos) },
        aVencer: { qty: aVencer.qty, valor: brl(aVencer.valor) },
        vencidosAguardando: { qty: vencidosTot.qty, valor: brl(vencidosTot.valor) },
        evasao: { qty: evasao.qty, valor: brl(evasao.valor), pct: pct(evasao.qty, emitidos) },
        erros: { qty: stats.erros.qty, valor: brl(stats.erros.valor), itens: erros },
        encerrados: stats.encerrados.qty,
        entradas: entradas
            ? { qty: entradas.pagos.qty, valor: brl(entradas.pagos.valor),
                foraDoPeriodo: Math.max(0, entradas.pagos.qty - stats.pagos.qty),
                valorForaDoPeriodo: brl(Math.max(0, entradas.pagos.valor - stats.pagos.valor)) }
            : null,
        empreendimentos: [...porEmp.values()]
            .filter(e => e.qEmitidos > 0)
            .sort((a, b) => b.emitidos - a.emitidos)
            .map(e => ({
                nome: e.nome, emitidos: brl(e.emitidos), pagos: brl(e.pagos),
                pendente: brl(e.pendente), evasao: brl(e.evasao), evasaoPct: pct(e.qEvasao, e.qEmitidos),
            })),
        vencidos: vencidos.sort((a, b) => a.vencimento.localeCompare(b.vencimento)),
        link: `${OFFICE_URL}/financeiro/cobranca/ato`,
    };
}

/** Destinatários: lista ou texto separado por vírgula/ponto e vírgula/linha. */
export function normalizarDestinatarios(para) {
    const lista = (Array.isArray(para) ? para : String(para || '').split(/[,;\s]+/))
        .map(s => String(s).trim().toLowerCase())
        .filter(Boolean);
    const unicos = [...new Set(lista)];
    const invalidos = unicos.filter(e => !EMAIL_RE.test(e));
    return { emails: unicos.filter(e => EMAIL_RE.test(e)), invalidos };
}

export async function enviarResumo(user, filtros, { para, observacao } = {}) {
    const { emails, invalidos } = normalizarDestinatarios(para);
    if (invalidos.length) {
        const err = new Error(`E-mail inválido: ${invalidos.join(', ')}`);
        err.status = 400; throw err;
    }
    if (!emails.length) { const err = new Error('Informe ao menos um destinatário.'); err.status = 400; throw err; }
    if (emails.length > MAX_DESTINATARIOS) {
        const err = new Error(`No máximo ${MAX_DESTINATARIOS} destinatários por envio.`); err.status = 400; throw err;
    }

    const resumo = await montarResumo(user, filtros);
    await sendEmail('cobranca.ato.resumo', emails, {
        ...resumo,
        observacao: String(observacao || '').trim().slice(0, 2000) || null,
        remetente: user?.username || user?.name || user?.email || null,
    });
    return { enviados: emails, periodo: resumo.periodo };
}

export default { montarResumo, enviarResumo, normalizarDestinatarios };

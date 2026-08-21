// services/about/aboutMetricsService.js
// ─────────────────────────────────────────────────────────────────────────────
// Números AO VIVO da tela "Sobre o Office" (/sobre e /sobre/relatorio).
//
// O relatório executivo nasceu com números congelados em 04/08/2026. Aqui eles
// passam a sair do próprio banco, então crescem sozinhos conforme o sistema é
// usado: cada contrato validado, boleto emitido, reserva cancelada e imobiliária
// cadastrada entra na conta no mesmo dia.
//
// São DUAS naturezas de ganho, somadas no fim:
//   1. Trabalho devolvido — volume real × minutos por caso × custo-hora. Cresce
//      quando o sistema é usado.
//   2. Assinatura cortada — a mensalidade que a empresa deixou de pagar rende a
//      cada dia corrido desde a data do corte (taxa anual / 365 × dias). Cresce
//      com o calendário, mesmo em dia parado.
//
// As premissas abaixo são as mesmas do relatório aprovado (não mudar sem pedir:
// os números já foram apresentados à diretoria).
//
// Cache em memória de 30 min: a tela é de leitura e as queries varrem histórico
// inteiro; sem cache, cada F5 de admin bateria no banco à toa.

import db from '../../models/sequelize/index.js';

export const ASSUMPTIONS = {
    // Custo-hora médio de um analista (relatório executivo, agosto/2026).
    hourlyCost: 19.32,

    // Minutos que cada caso levaria no braço. Vieram da medição do Gustavo.
    minutesPerCase: {
        contractValidation: 10,
        boletoIssue: 15,
        titularBlock: 5,
        realEstateRegistration: 15,
        reservaCancel: 10,
    },

    // Ferramentas cortadas: `annual` é o custo anual que deixou de existir e
    // `since` é quando o corte passou a valer.
    recurringSavings: [
        { key: 'rd_station', label: 'RD Station', annual: 33000, since: '2026-05-01' },
        // 07/05/2026: quando o banco próprio do Sienge entrou no ar e a
        // dependência do Postgres de terceiro deixou de ser paga.
        { key: 'external_db', label: 'Banco de dados de terceiro', annual: 3600, since: '2026-05-07' },
    ],

    // Potencial ainda não capturado (roadmap). Fixo: é projeção, não medição.
    mappedPotentialAnnual: 330000,
};

const CACHE_TTL_MS = 30 * 60 * 1000;
let cache = { at: 0, data: null };

/** Uma query isolada não pode derrubar o conjunto: falhou, devolve o fallback. */
async function safeQuery(label, sql, fallback) {
    try {
        const [rows] = await db.sequelize.query(sql);
        return rows?.[0] ?? fallback;
    } catch (err) {
        console.error(`[ABOUT_METRICS] falha em ${label}:`, err.message);
        return null;
    }
}

function daysSince(dateStr) {
    const start = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(start.getTime())) return 0;
    return Math.max(0, Math.floor((Date.now() - start.getTime()) / 86400000));
}

async function collect() {
    // Boletos: só a VIA FINAL de cada reserva conta, mesma regra do
    // getHistoryStats da tela de Boletos — boleto baixado e reemitido não pode
    // contar duas vezes. Manter as duas leituras iguais é o que faz o número da
    // tela "Sobre" bater com o da tela de Boleto Caixa.
    const boleto = await safeQuery('boletos', `
        SELECT COUNT(*)::int                                                   AS emitidos,
               COALESCE(SUM(valor), 0)::float                                  AS valor_emitido,
               COUNT(*) FILTER (WHERE payment_status = 'paid')::int            AS pagos,
               COALESCE(SUM(valor) FILTER (WHERE payment_status = 'paid'), 0)::float AS valor_pago,
               COUNT(*) FILTER (WHERE payment_status = 'cancelled')::int       AS baixados,
               COALESCE(SUM(valor) FILTER (WHERE payment_status = 'cancelled'), 0)::float AS valor_baixado,
               COUNT(*) FILTER (WHERE payment_status NOT IN ('paid','cancelled')
                                   OR payment_status IS NULL)::int             AS em_aberto,
               COALESCE(SUM(valor) FILTER (WHERE payment_status NOT IN ('paid','cancelled')
                                              OR payment_status IS NULL), 0)::float AS valor_em_aberto
        FROM boleto_history
        WHERE id IN (
            SELECT MAX(id) FROM boleto_history WHERE status = 'success' GROUP BY idreserva
        )
    `, { emitidos: 0, valor_emitido: 0, pagos: 0, valor_pago: 0, baixados: 0, valor_baixado: 0, em_aberto: 0, valor_em_aberto: 0 });

    // Emissões barradas pela validação do titular. Não existe flag dedicada: o
    // bloqueio vira status='error' com prefixo fixo na mensagem (ver
    // services/boleto/BoletoGenerationService.js). Outros erros de emissão
    // (teto de valor, múltiplas parcelas) NÃO entram aqui.
    const titular = await safeQuery('titular', `
        SELECT COUNT(*)::int AS barrados
        FROM boleto_history
        WHERE status = 'error'
          AND error_message LIKE 'Divergência nos dados do titular%'
    `, { barrados: 0 });

    // Cancelamento de reservas: um caso por reserva (a tentativa mais recente),
    // igual ao agrupamento padrão da tela de Cancelamento.
    const cancel = await safeQuery('cancelamentos', `
        SELECT COUNT(*)::int                                          AS casos,
               COUNT(*) FILTER (WHERE status = 'success')::int        AS sucesso,
               COUNT(*) FILTER (WHERE status IN ('blocked','held','error'))::int AS conferencia_humana
        FROM reserva_cancel_history
        WHERE id IN (SELECT MAX(id) FROM reserva_cancel_history GROUP BY idreserva)
    `, { casos: 0, sucesso: 0, conferencia_humana: 0 });

    // Cada métrica com seu próprio filtro: unidade liberada e contrato excluído
    // são ações independentes e um WHERE comum inflaria a contagem de unidades.
    const unidades = await safeQuery('unidades liberadas', `
        SELECT COUNT(DISTINCT idunidade_cv) FILTER (WHERE cv_unidade_disponibilizada = true)::int AS unidades,
               COUNT(*) FILTER (WHERE sienge_contrato_excluido = true)::int                       AS contratos_excluidos
        FROM reserva_cancel_history
    `, { unidades: 0, contratos_excluidos: 0 });

    // Validador por IA. Falha técnica do provider não grava linha, então o total
    // é sempre aprovados + reprovados.
    const contratos = await safeQuery('contratos', `
        SELECT COUNT(*)::int                                            AS total,
               COUNT(*) FILTER (WHERE status = 'APROVADO')::int         AS aprovados,
               COUNT(*) FILTER (WHERE status = 'REPROVADO')::int        AS reprovados
        FROM validation_histories
    `, { total: 0, aprovados: 0, reprovados: 0 });

    // Imobiliárias cadastradas pelo link público. O convite multi-uso fica
    // eternamente em status='invite', então filtrar por 'completed' já descarta
    // o pai e conta só os cadastros de verdade.
    const imobiliarias = await safeQuery('imobiliárias', `
        SELECT COUNT(*)::int AS por_link
        FROM real_estate_registrations
        WHERE source = 'public' AND status = 'completed'
    `, { por_link: 0 });

    // Base total de imobiliárias no CV: dá a dimensão de onde os cadastros por
    // link entram. Espelho do CV, não conta como produção do Office.
    const imobiliariasBase = await safeQuery('base de imobiliárias', `
        SELECT COUNT(*)::int AS base FROM cv_imobiliarias
    `, { base: 0 });

    return { boleto, titular, cancel, unidades, contratos, imobiliarias, imobiliariasBase };
}

export async function getAboutMetrics({ force = false } = {}) {
    if (!force && cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
        return { ...cache.data, cached: true };
    }

    const raw = await collect();
    const { minutesPerCase: min, hourlyCost } = ASSUMPTIONS;

    // Um indicador que falhou entra como 0 no cálculo e é sinalizado em
    // `unavailable`, para a tela mostrar o número congelado do relatório.
    const unavailable = Object.entries(raw).filter(([, v]) => v === null).map(([k]) => k);
    const n = (obj, key) => Number(obj?.[key] ?? 0) || 0;

    const counts = {
        contratosValidados: n(raw.contratos, 'total'),
        contratosAprovados: n(raw.contratos, 'aprovados'),
        contratosReprovados: n(raw.contratos, 'reprovados'),
        boletosEmitidos: n(raw.boleto, 'emitidos'),
        boletosPagos: n(raw.boleto, 'pagos'),
        boletosEmAberto: n(raw.boleto, 'em_aberto'),
        boletosBaixados: n(raw.boleto, 'baixados'),
        valorEmitido: n(raw.boleto, 'valor_emitido'),
        valorPago: n(raw.boleto, 'valor_pago'),
        valorEmAberto: n(raw.boleto, 'valor_em_aberto'),
        valorBaixado: n(raw.boleto, 'valor_baixado'),
        titularBarrados: n(raw.titular, 'barrados'),
        cancelamentosCasos: n(raw.cancel, 'casos'),
        cancelamentosSucesso: n(raw.cancel, 'sucesso'),
        cancelamentosConferencia: n(raw.cancel, 'conferencia_humana'),
        unidadesLiberadas: n(raw.unidades, 'unidades'),
        contratosExcluidosSienge: n(raw.unidades, 'contratos_excluidos'),
        imobiliariasPorLink: n(raw.imobiliarias, 'por_link'),
        imobiliariasBase: n(raw.imobiliariasBase, 'base'),
    };

    // Percentuais que o relatório cita em texto.
    const pct = (part, whole) => (whole > 0 ? Number(((part / whole) * 100).toFixed(1)) : 0);
    counts.taxaSucessoCancelamento = pct(counts.cancelamentosSucesso, counts.cancelamentosCasos);
    counts.taxaEvasaoBoleto = pct(counts.boletosBaixados, counts.boletosEmitidos);
    counts.taxaPagamentoBoleto = pct(counts.boletosPagos, counts.boletosEmitidos);

    // ── 1. Trabalho devolvido ────────────────────────────────────────────────
    const breakdown = [
        { key: 'contracts', label: 'Validação de contratos', cases: counts.contratosValidados, minutes: min.contractValidation },
        { key: 'boleto', label: 'Emissão e envio do boleto do ato', cases: counts.boletosEmitidos, minutes: min.boletoIssue },
        { key: 'titular', label: 'Tratativa de dado inválido do titular', cases: counts.titularBarrados, minutes: min.titularBlock },
        { key: 'realestate', label: 'Cadastro de imobiliária no CV', cases: counts.imobiliariasPorLink, minutes: min.realEstateRegistration },
        { key: 'cancel', label: 'Cancelamento de reserva no CRM e no ERP', cases: counts.cancelamentosCasos, minutes: min.reservaCancel },
    ].map(item => ({ ...item, hours: (item.cases * item.minutes) / 60 }));

    const totalCases = breakdown.reduce((sum, i) => sum + i.cases, 0);
    const totalHours = breakdown.reduce((sum, i) => sum + i.hours, 0);
    const hoursValue = totalHours * hourlyCost;

    // ── 2. Assinatura cortada, proporcional aos dias corridos ────────────────
    const subscriptions = ASSUMPTIONS.recurringSavings.map(s => {
        const days = daysSince(s.since);
        return { ...s, days, accumulated: (s.annual / 365) * days };
    });
    const subscriptionsAccumulated = subscriptions.reduce((sum, s) => sum + s.accumulated, 0);
    const subscriptionsAnnual = ASSUMPTIONS.recurringSavings.reduce((sum, s) => sum + s.annual, 0);

    const data = {
        generatedAt: new Date().toISOString(),
        counts,
        work: { totalCases, totalHours, hoursValue, breakdown },
        subscriptions: { annual: subscriptionsAnnual, accumulated: subscriptionsAccumulated, items: subscriptions },
        totalSaved: hoursValue + subscriptionsAccumulated,
        mappedPotentialAnnual: ASSUMPTIONS.mappedPotentialAnnual,
        assumptions: { hourlyCost, minutesPerCase: min },
        unavailable,
    };

    cache = { at: Date.now(), data };
    return { ...data, cached: false };
}

export function clearAboutMetricsCache() {
    cache = { at: 0, data: null };
}

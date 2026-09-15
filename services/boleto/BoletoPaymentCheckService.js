// services/boleto/BoletoPaymentCheckService.js
//
// Verifica diariamente o status dos boletos emitidos no Ecobrança e age:
//   - LIQUIDADO → marca como `paid` e posta mensagem com STATUS DO ATO: ATO PAGO.
//   - EM ABERTO + passou da janela tolerância → faz baixa, marca `cancelled`,
//     posta mensagem com STATUS DO ATO: ATO BAIXADO.
//
// A etapa da reserva no CV NÃO é tocada por este serviço (nem por nenhum outro
// do ato): a reserva fica em "Envio Sienge", a única etapa em que o lote do CV
// ainda tenta mandar a venda ao ERP. O desfecho do ato vive na mensagem - ver
// lib/atoStatus.js.
//   - EM ABERTO + dentro da janela → só registra evento "ainda em aberto".
//   - Outras situações → registra evento bruto (não interfere).
//
// Idempotência garantida:
//   - Boletos com payment_status != 'pending' são pulados (não re-processados).
//   - Baixa só roda se Ecobrança retorna "EM ABERTO" — se já foi baixado/pago,
//     `consultaBaixaTitulo.baixarTitulo` aborta antes de clicar.
//   - Eventos são append-only (timeline reconstruível).

import db from '../../models/sequelize/index.js';
import apiCv from '../../lib/apiCv.js';
import { runEcoBatch } from '../../playwright/services/ecoCheckService.js';
import EventLogger from './BoletoEventLogger.js';
import EcoLock from './BoletoEcoLockService.js';
import { ATO_STATUS, comStatusAto } from '../../lib/atoStatus.js';
import { podeConsultarHoje } from '../../lib/businessCalendar.js';
import { sendEmail } from '../../email/email.service.js';
import { EmailType } from '../../email/types.js';
import BoletoNotify from './BoletoNotifyService.js';
import { Op } from 'sequelize';

const { BoletoHistory, BoletoSettings } = db;

// Situações do Ecobrança que significam "o cliente pagou".
//
// Além de LIQUIDADO, a consulta devolve "TITULO JA PAGO NO DIA DD/MM/AAAA"
// quando o pagamento entrou mas o título ainda não migrou pra liquidado.
// Enquanto só LIQUIDADO era reconhecido, esse boleto seguia `pending` e no dia
// seguinte a consulta voltava "BAIXADO POR DEVOLUÇÃO" — o boleto pago acabava
// marcado como cancelado (11 casos entre 09 e 13/08/2026).
const RE_SITUACAO_PAGA = /LIQUIDAD|J[AÁ]\s*PAGO/i;

export function isSituacaoPaga(situacao) {
    return RE_SITUACAO_PAGA.test(String(situacao || ''));
}

// Situacao ambigua: e a que o Ecobranca devolve tanto para uma baixa real
// quanto para um titulo pago no dia anterior (ver acima). Boleto cancelado por
// ela NAO e estado final ate alguem reconsultar - ver
// `revalidarBaixadosPorDevolucao` e `reconsultarBaixadoAntesDeEmitir`.
const RE_BAIXADO_POR_DEVOLUCAO = /BAIXAD[OA]\s+POR\s+DEVOLU/i;

/** Where dos boletos do ATO cancelados pela situacao ambigua "BAIXADO POR DEVOLUCAO". */
export function whereBaixadosPorDevolucao(extra = {}) {
    return {
        status: 'success',
        payment_status: 'cancelled',
        parcela_id: null,
        ignorado: false,
        nosso_numero: { [Op.ne]: null },
        last_check_situation: { [Op.iLike]: 'BAIXADO POR DEVOLU%' },
        ...extra,
    };
}

/**
 * Data do pagamento quando a situacao e "TITULO JA PAGO NO DIA DD/MM/AAAA".
 * Sem data no texto devolve null (o chamador usa a data da leitura).
 */
export function dataPagamentoDaSituacao(situacao) {
    const m = /PAGO\s+NO\s+DIA\s+(\d{2})\/(\d{2})\/(\d{4})/i.exec(String(situacao || ''));
    if (!m) return null;
    const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12, 0, 0));
    return Number.isNaN(d.getTime()) ? null : d;
}

function formatDateBr(isoOrDate) {
    if (!isoOrDate) return '-';
    const s = String(isoOrDate);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        const [y, m, d] = s.slice(0, 10).split('-');
        return `${d}/${m}/${y}`;
    }
    const d = new Date(isoOrDate);
    return d.toLocaleDateString('pt-BR');
}

async function sendCvMessageSafe(idreserva, mensagem, historyId, tag, status = null) {
    try {
        // Com a etapa do CV fora de uso, o status do ato vem na primeira linha
        // da mensagem - ver lib/atoStatus.js.
        if (status) mensagem = comStatusAto(status, mensagem);
        await apiCv.post('/v2/comercial/reservas/mensagens', { idreserva, mensagem });
        await EventLogger.log({
            historyId, idreserva, type: 'cv_message_sent',
            severity: 'success', message: `Mensagem postada no CV: ${tag}`,
        });
        return { ok: true };
    } catch (err) {
        const detail = err?.response?.data?.error || err?.response?.data?.mensagem || err.message;
        await EventLogger.log({
            historyId, idreserva, type: 'cv_message_failed',
            severity: 'error', message: `Falha postando mensagem (${tag}): ${detail}`,
            data: { httpStatus: err?.response?.status },
        });
        return { ok: false, error: detail };
    }
}


/**
 * Decide a ação pra um boleto baseado em vencimento + tolerância.
 * Retorna 'consultar' (só ver status) ou 'baixar' (consultar + se EM ABERTO, baixar).
 *
 * "baixar" só é selecionado se hoje >= dataConsulta(vencimento). Mesmo assim,
 * a baixa é abortada in-flight se o Ecobrança retornar situação != EM ABERTO.
 */
function decidirAcao(boleto, toleranciaDiasUteis) {
    // Boleto que já saiu de `pending` só entra na rodada pela janela de
    // revalidação (ver `revalidacao_baixado_dias`). Ali a rodada é só de
    // leitura — baixar de novo algo já baixado não faria nada além de ruído.
    if (boleto.payment_status !== 'pending') return 'consultar';
    if (!boleto.vencimento) return 'consultar'; // sem venc → não tem como decidir baixa
    return podeConsultarHoje(boleto.vencimento, toleranciaDiasUteis) ? 'baixar' : 'consultar';
}

/**
 * Pega o CNPJ do empreendimento no CV. Cache em memória pra evitar repetição
 * dentro da mesma rodada.
 */
async function fetchCnpjEmpresaCache(cache, idempreendimento_cv) {
    if (!idempreendimento_cv) return null;
    const key = String(idempreendimento_cv);
    if (cache.has(key)) return cache.get(key);
    try {
        const resp = await apiCv.get(`/v1/cadastros/empreendimentos/${idempreendimento_cv}`, {
            params: { limite_dados_unidade: 1 },
        });
        const cnpj = resp.data?.cnpj_empesa || null;
        cache.set(key, cnpj);
        return cnpj;
    } catch (err) {
        cache.set(key, null);
        return null;
    }
}

/**
 * Busca o idempreendimento_cv pra cada reserva (caso o history não tenha
 * salvado). Faz 1 GET por reserva — cacheado por reserva.
 */
async function fetchReservaIdEmpreendimento(idreserva) {
    try {
        const { data } = await apiCv.get(`/v1/comercial/reservas/${idreserva}`);
        return data?.[idreserva]?.unidade?.idempreendimento_cv || null;
    } catch {
        return null;
    }
}

/**
 * Rodada completa de check. Idempotente, append-only.
 * Retorna estatísticas pra log.
 */
export async function runDailyCheck({ idreservas = null } = {}) {
    console.log('[BOLETO_CHECK] Iniciando rodada diária de verificação de boletos...');

    // 1) Settings
    const settings = await BoletoSettings.findByPk(1);
    if (!settings) {
        console.warn('[BOLETO_CHECK] BoletoSettings não configurado — abortando.');
        return { skipped: true, reason: 'no_settings' };
    }
    const tolerancia = Number(settings.tolerancia_dias_uteis) || 1;
    const revalidacaoDias = Math.max(0, Number(settings.revalidacao_baixado_dias ?? 5) || 0);

    if (!settings.eco_usuario || !settings.eco_senha) {
        console.warn('[BOLETO_CHECK] Credenciais Ecobrança não configuradas — abortando.');
        return { skipped: true, reason: 'no_eco_credentials' };
    }

    // 2) Boletos elegíveis: status='success' (emitidos), com vencimento e
    //    nosso_numero válidos, em um de dois grupos:
    //      a) payment_status='pending' — o fluxo normal.
    //      b) payment_status='cancelled' há menos de `revalidacao_baixado_dias`
    //         — janela de revalidação. O Ecobrança já devolveu "BAIXADO POR
    //         DEVOLUÇÃO" pra título que dias depois aparecia LIQUIDADO no
    //         extrato; como `cancelled` era terminal, a rodada nunca mais
    //         olhava e o pagamento ficava invisível pro Office. Nessa janela a
    //         rodada é só de leitura (ver decidirAcao) e o único desfecho
    //         possível é promover pra `paid`.
    //    Permite filtrar por idreservas pra debug/reprocessamento manual.
    const revalidarDesde = revalidacaoDias > 0
        ? new Date(Date.now() - revalidacaoDias * 24 * 60 * 60 * 1000)
        : null;
    const where = {
        status: 'success',
        nosso_numero: { [Op.ne]: null },
        vencimento: { [Op.ne]: null },
        [Op.or]: [
            { payment_status: 'pending' },
            ...(revalidarDesde
                ? [{ payment_status: 'cancelled', cancelled_at: { [Op.gte]: revalidarDesde } }]
                : []),
        ],
    };
    if (Array.isArray(idreservas) && idreservas.length) {
        where.idreserva = idreservas;
    }
    const boletos = await BoletoHistory.findAll({
        where,
        order: [['vencimento', 'ASC'], ['id', 'ASC']],
    });

    if (!boletos.length) {
        console.log('[BOLETO_CHECK] Nenhum boleto pendente. Nada a fazer.');
        return { skipped: false, processed: 0 };
    }

    const emRevalidacao = boletos.filter(b => b.payment_status !== 'pending').length;
    console.log(
        `[BOLETO_CHECK] ${boletos.length} boleto(s) pra verificar `
        + `(${boletos.length - emRevalidacao} pendente(s) + ${emRevalidacao} em revalidação de baixa, janela ${revalidacaoDias}d).`,
    );

    // 3-4) Agrupa por CNPJ e monta o batch (consultar/baixar por boleto).
    const { empresas, semCnpj } = await agruparPorEmpresa(boletos, b => decidirAcao(b, tolerancia));
    console.log(`[BOLETO_CHECK] Batch montado: ${empresas.length} empresa(s), ${boletos.length - semCnpj.length} boleto(s).`);

    // 5) Roda o batch no Playwright (uma sessão Ecobrança). Cada resultado é
    //    aplicado na hora; se o batch cair no meio, o que já foi lido está salvo.
    const { results, corrigidos } = await rodarBatch(settings, empresas);

    // 6) Boleto que estava "baixado por devolução" e voltou como PAGO pode ter
    //    ganhado um irmão: a emissão seguinte viu o ato sem pagamento e cobrou
    //    de novo (reserva 8086, 14/09/2026). Baixa essa duplicata agora.
    const duplicatas = await baixarDuplicatasDeAtosPagos(corrigidos, settings);

    const stats = {
        total: boletos.length,
        em_revalidacao: emRevalidacao,
        sem_cnpj: semCnpj.length,
        consultados: results.filter(r => r.ok && r.acao === 'consultar').length,
        baixas_tentadas: results.filter(r => r.ok && r.acao === 'baixar').length,
        baixas_efetuadas: results.filter(r => r.ok && r.baixaConfirmada).length,
        pagos: results.filter(r => r.ok && isSituacaoPaga(r.situacao)).length,
        pagos_corrigidos: corrigidos.length,
        duplicatas,
        falhas: results.filter(r => !r.ok).length,
    };
    console.log('[BOLETO_CHECK] Rodada concluída:', stats);
    return stats;
}

/**
 * Agrupa boletos por CNPJ da empresa (histórico primeiro, CV como fallback) e
 * monta o batch do Playwright. `acaoDe(boleto)` decide 'consultar' | 'baixar'.
 * Boleto sem CNPJ ganha evento e fica de fora (`semCnpj`).
 */
async function agruparPorEmpresa(boletos, acaoDe) {
    const cnpjCache = new Map();
    const semCnpj = [];
    const porEmpresa = new Map(); // cnpj → [boleto, ...]

    for (const b of boletos) {
        // O CNPJ gravado na emissão vale primeiro: evita uma chamada ao CV por
        // boleto e cobre reserva que não existe lá (plano de teste das parcelas).
        let cnpj = String(b.cnpj_empresa || '').replace(/\D/g, '') || null;
        if (!cnpj) {
            let idempreendimento_cv = null;
            try {
                idempreendimento_cv = await fetchReservaIdEmpreendimento(b.idreserva);
            } catch (_) {}
            cnpj = await fetchCnpjEmpresaCache(cnpjCache, idempreendimento_cv);
        }
        if (!cnpj) {
            semCnpj.push(b);
            continue;
        }
        if (!porEmpresa.has(cnpj)) porEmpresa.set(cnpj, []);
        porEmpresa.get(cnpj).push(b);
    }

    for (const b of semCnpj) {
        await EventLogger.log({
            historyId: b.id, idreserva: b.idreserva, type: 'payment_check_skipped',
            severity: 'warning', message: 'CNPJ da empresa não encontrado no CV — boleto pulado nesta rodada.',
        });
    }

    const empresas = [];
    for (const [cnpj, lista] of porEmpresa) {
        empresas.push({
            cnpj_empresa: cnpj,
            boletos: lista.map(b => ({
                historyId: b.id,
                idreserva: b.idreserva,
                nossoNumero: b.nosso_numero,
                acao: acaoDe(b),
                vencimento: b.vencimento,
            })),
        });
    }
    return { empresas, semCnpj };
}

/**
 * Roda o batch no Ecobrança aplicando cada resultado na hora. Envelopado em
 * try/catch: se runEcoBatch crashar no meio (browser morto, exceção fatal), os
 * boletos JÁ PROCESSADOS via onResult estão salvos; o resto fica pra próxima.
 * Devolve também `corrigidos`: boletos do ATO que estavam cancelados e a
 * leitura promoveu a pagos (candidatos a ter uma cobrança duplicada viva).
 */
async function rodarBatch(settings, empresas, aplicar = aplicarResultado) {
    let results = [];
    const corrigidos = [];
    if (!empresas.length) return { results, corrigidos };
    try {
        const out = await runEcoBatch({
            credentials: { usuario: settings.eco_usuario, senha: settings.eco_senha },
            empresas,
            onResult: async (r) => {
                try {
                    const res = await aplicar(r, {});
                    if (res?.outcome === 'pago_corrigido' && res.history) corrigidos.push(res.history);
                } catch (err) {
                    console.error(`[BOLETO_CHECK] aplicarResultado falhou (hist ${r.historyId}): ${err.message}`);
                }
            },
        });
        results = out.results || [];
    } catch (err) {
        console.error('[BOLETO_CHECK] Batch Playwright crashou no meio:', err.message);
        // Não relança — preferimos terminar a rodada com stats parciais a perder
        // tudo. Os boletos já processados via onResult permanecem salvos.
    }
    return { results, corrigidos };
}

/**
 * Aplica o resultado de UM boleto: registra evento, atualiza history, dispara
 * mudança de situação + mensagem no CV quando aplicável.
 */
async function aplicarResultado(r, _opts = {}) {
    if (!r.historyId) return;
    const history = await BoletoHistory.findByPk(r.historyId);
    if (!history) return;

    // Boleto de PARCELA mensal: a parcela e quem muda de estado, e a mensagem
    // na reserva fala em "parcela 3 de 60", nao em ato. Import dinamico para
    // nao fechar ciclo (o service da parcela usa isSituacaoPaga daqui).
    if (history.parcela_id) {
        const { aplicarResultadoParcela } = await import('./ParcelaEmissaoService.js');
        return aplicarResultadoParcela(r, history);
    }

    // Sempre atualiza last_checked / last_situation
    const baseUpdate = {
        last_checked_at: new Date(),
        last_check_situation: r.situacao || (r.found === false ? 'NAO_ENCONTRADO' : null),
    };

    // ── Falha técnica (não conseguiu consultar) ──────────────────────────────
    if (!r.ok) {
        await EventLogger.log({
            historyId: history.id, idreserva: history.idreserva, type: 'payment_check_error',
            severity: 'error', message: r.error || 'Erro desconhecido na verificação.',
            data: { error: r.error },
        });
        await history.update(baseUpdate);
        return;
    }

    // ── Título não encontrado no Ecobrança ───────────────────────────────────
    // Agora a consulta usa /consulta_titulo (lista TODOS os títulos, não só
    // os em aberto). Se mesmo assim não encontrou, é problema real: ou o
    // nosso número está errado, ou o boleto nunca foi emitido nessa empresa.
    // Mantém pending pra admin investigar via UI.
    if (r.found === false) {
        await EventLogger.log({
            historyId: history.id, idreserva: history.idreserva, type: 'payment_check_not_found',
            severity: 'error',
            message: `Nosso Número ${history.nosso_numero} NÃO foi encontrado no Ecobrança (nem em /consulta_titulo). Verifique se o número está correto e se a empresa selecionada é a mesma da emissão.`,
            data: { rawConsulta: r.raw || null },
        });
        await history.update({
            ...baseUpdate,
            last_check_situation: 'NAO_ENCONTRADO',
        });
        return;
    }

    // ── LIQUIDADO / "TITULO JA PAGO NO DIA ..." ──────────────────────────────
    if (isSituacaoPaga(r.situacao)) {
        if (history.payment_status === 'paid') {
            // Já estava marcado — não faz nada, só atualiza last_checked.
            await history.update(baseUpdate);
            return;
        }
        await EventLogger.log({
            historyId: history.id, idreserva: history.idreserva, type: 'paid',
            severity: 'success', message: `Boleto pago no Ecobrança — situação "${r.situacao}" (Nosso Nº ${history.nosso_numero}).`,
            data: { situacao: r.situacao, dados: r.dados || null },
        });
        const eraCancelado = history.payment_status === 'cancelled';
        // "TITULO JA PAGO NO DIA 10/08/2026" traz a data real; LIQUIDADO nao,
        // e ai vale a data da leitura.
        await history.update({
            ...baseUpdate,
            payment_status: 'paid',
            paid_at: dataPagamentoDaSituacao(r.situacao) || new Date(),
            cancelled_at: null,
        });
        const msg = [
            '✅ Boleto pago!',
            '',
            `🔢 Nosso Número: ${history.nosso_numero}`,
            `💰 Valor: R$ ${Number(history.valor || 0).toFixed(2).replace('.', ',')}`,
            history.vencimento ? `📅 Vencimento: ${formatDateBr(history.vencimento)}` : null,
            `🏦 Situação no Ecobrança: ${r.situacao}`,
            '',
            eraCancelado
                ? 'Correção: este boleto havia sido marcado como baixado por devolução. O pagamento foi confirmado no Ecobrança e o aviso anterior fica sem efeito.'
                : null,
            eraCancelado ? '' : null,
            'Detecção automática pelo scheduler diário.',
        ].filter(Boolean).join('\n');
        await sendCvMessageSafe(history.idreserva, msg, history.id, 'pago', ATO_STATUS.PAGO);
        return { outcome: eraCancelado ? 'pago_corrigido' : 'pago', history };
    }

    // ── BAIXADO/CANCELADO externo (descoberto pela consulta detalhada) ───────
    // O título está no Ecobrança mas com situação que indica que já foi
    // resolvido fora do nosso sistema (baixa manual, cancelamento, etc.).
    // Não precisa baixar de novo — só registra e move pra cancelled.
    const sit = String(r.situacao || '').toUpperCase();
    const isJaBaixado = /BAIXAD[OA]|CANCELAD[OA]|DEVOLVID[OA]/i.test(sit);

    // Baixa NÃO desfaz pagamento já observado. O Ecobrança chega a devolver
    // "BAIXADO POR DEVOLUÇÃO" pra título que já tinha aparecido como pago —
    // sem esta guarda o `paid` virava `cancelled` e o cliente recebia aviso
    // de boleto baixado depois de ter pago.
    if (isJaBaixado && history.payment_status === 'paid') {
        await EventLogger.log({
            historyId: history.id, idreserva: history.idreserva,
            type: 'payment_check', severity: 'warning',
            message: `Ecobrança devolveu "${sit}" para boleto já marcado como PAGO — leitura registrada, pagamento mantido.`,
            data: { situacao: sit, ignoradoPorPago: true },
        });
        await history.update(baseUpdate);
        return;
    }

    // Já cancelado (inclusive nas releituras da janela de revalidação): só
    // atualiza o last_checked. Repetir evento e mensagem no CV a cada rodada
    // encheria a timeline da reserva de aviso duplicado.
    if (isJaBaixado && history.payment_status === 'cancelled') {
        await history.update(baseUpdate);
        return;
    }

    if (isJaBaixado) {
        await EventLogger.log({
            historyId: history.id, idreserva: history.idreserva,
            type: 'baixa_confirmed', severity: 'warning',
            message: `Boleto já consta como "${sit}" no Ecobrança (baixa externa). Marcando como cancelado no nosso sistema.`,
            data: { situacao: sit, externalBaixa: true },
        });
        await history.update({
            ...baseUpdate,
            payment_status: 'cancelled',
            cancelled_at: new Date(),
            last_check_situation: sit,
        });
        const msg = [
            '⚠️ Boleto baixado externamente',
            '',
            `🔢 Nosso Número: ${history.nosso_numero}`,
            `🏦 Situação no Ecobrança: ${sit}`,
            `💰 Valor: R$ ${Number(history.valor || 0).toFixed(2).replace('.', ',')}`,
            history.vencimento ? `📅 Vencimento: ${formatDateBr(history.vencimento)}` : null,
            '',
            'Detectamos que o boleto foi baixado/cancelado diretamente no Ecobrança, fora deste sistema. Marcamos como cancelado no histórico.',
        ].filter(Boolean).join('\n');
        await sendCvMessageSafe(history.idreserva, msg, history.id, 'baixado externamente', ATO_STATUS.BAIXADO);
        return;
    }

    // ── BAIXA CONFIRMADA (acao=baixar e Ecobrança aceitou) ───────────────────
    if (r.baixaConfirmada) {
        await EventLogger.log({
            historyId: history.id, idreserva: history.idreserva, type: 'baixa_confirmed',
            severity: 'success', message: `Baixa por devolução confirmada (${r.mensagemBaixa || 'sucesso'}).`,
            data: { mensagemBaixa: r.mensagemBaixa, situacaoAnterior: r.situacao },
        });
        await history.update({
            ...baseUpdate,
            payment_status: 'cancelled',
            cancelled_at: new Date(),
            last_check_situation: 'BAIXADO',
        });
        const msg = [
            '❌ Boleto baixado por devolução',
            '',
            `🔢 Nosso Número: ${history.nosso_numero}`,
            `💰 Valor: R$ ${Number(history.valor || 0).toFixed(2).replace('.', ',')}`,
            history.vencimento ? `📅 Vencimento: ${formatDateBr(history.vencimento)}` : null,
            '',
            'Boleto vencido sem pagamento — baixa automática realizada no Ecobrança.',
            'Caso ainda haja necessidade de cobrança, será preciso gerar novo boleto.',
        ].filter(Boolean).join('\n');
        await sendCvMessageSafe(history.idreserva, msg, history.id, 'baixado', ATO_STATUS.BAIXADO);
        return;
    }

    // ── BAIXA ABORTADA (não era EM ABERTO no momento de baixar) ──────────────
    if (r.acao === 'baixar' && r.abortReason) {
        await EventLogger.log({
            historyId: history.id, idreserva: history.idreserva, type: 'baixa_aborted',
            severity: 'warning',
            message: `Baixa abortada (safety) — situação no Ecobrança era "${r.situacao || '?'}".`,
            data: { abortReason: r.abortReason },
        });
        await history.update(baseUpdate);
        return;
    }

    // ── EM ABERTO ainda dentro da janela (acao=consultar) ────────────────────
    await EventLogger.log({
        historyId: history.id, idreserva: history.idreserva, type: 'payment_check',
        severity: 'info', message: `Boleto ainda ${r.situacao || 'pendente'} no Ecobrança.`,
        data: { situacao: r.situacao, acao: r.acao },
    });
    await history.update(baseUpdate);
}

/**
 * Baixa IMEDIATA do boleto pendente de uma reserva CANCELADA — chamada pelo
 * fluxo de cancelamento (ReservaCancelService.validarAto) pra impedir que o
 * cliente pague um boleto de reserva morta.
 *
 * Diferenças pro fluxo diário (runDailyCheck):
 *   - Ignora a janela de vencimento — baixa AGORA, independente do venc.
 *   - NÃO altera a situação do CV (o fluxo de cancelamento é dono do workflow).
 *   - Mensagem no CV explica que a baixa foi pelo cancelamento da reserva.
 *   - Cascateia o `cancelled` pras tentativas "ignoradas" da reserva (linhas
 *     espelho do mesmo boleto — sem isso a listagem agrupada segue "Pendente").
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   outcome: 'baixado'|'ja_baixado'|'pago'|'nao_encontrado'|'sem_boleto'|'falha',
 *   detalhe: string,
 * }>}
 */
export async function baixarBoletoPorCancelamento(idreserva, { motivo = 'cancelamento da reserva' } = {}) {
    const boleto = await BoletoHistory.findOne({
        where: {
            idreserva,
            status: 'success',
            payment_status: 'pending',
            parcela_id: null, // o ato; boletos de parcela sao baixados pela rodada de parcelas
            ignorado: false,
            nosso_numero: { [Op.ne]: null },
        },
        order: [['id', 'DESC']],
    });
    if (!boleto) {
        return { ok: true, outcome: 'sem_boleto', detalhe: 'nenhum boleto pendente com nosso número registrado.' };
    }

    const settings = await BoletoSettings.findByPk(1);
    if (!settings?.eco_usuario || !settings?.eco_senha) {
        return { ok: false, outcome: 'falha', detalhe: 'credenciais do Ecobrança não configuradas no módulo Boleto Caixa.' };
    }

    // CNPJ da empresa: histórico primeiro, CV como fallback.
    let cnpj = String(boleto.cnpj_empresa || '').replace(/\D/g, '') || null;
    if (!cnpj) {
        const idemp = await fetchReservaIdEmpreendimento(idreserva);
        cnpj = await fetchCnpjEmpresaCache(new Map(), idemp);
    }
    if (!cnpj) {
        return { ok: false, outcome: 'falha', detalhe: 'CNPJ da empresa não encontrado (nem no histórico nem no CV).' };
    }

    // Lock do Ecobrança com espera curta — colisão com emissão/scheduler é rara,
    // mas se seguir ocupado o cancelamento bloqueia com mensagem clara e pode
    // ser reprocessado pela tela.
    const owner = `baixa:cancel:res=${idreserva}:hist=${boleto.id}:${new Date().toISOString()}`;
    let locked = false;
    for (let i = 0; i < 12 && !locked; i++) {
        locked = await EcoLock.acquire(owner, 10);
        if (!locked) await new Promise(r => setTimeout(r, 5000));
    }
    if (!locked) {
        return { ok: false, outcome: 'falha', detalhe: 'Ecobrança ocupado (lock) — reprocesse o cancelamento em alguns minutos.' };
    }

    let r = null;
    try {
        const out = await runEcoBatch({
            credentials: { usuario: settings.eco_usuario, senha: settings.eco_senha },
            empresas: [{
                cnpj_empresa: cnpj,
                boletos: [{ historyId: boleto.id, idreserva, nossoNumero: boleto.nosso_numero, acao: 'baixar' }],
            }],
        });
        r = out.results?.[0] || null;
    } catch (err) {
        r = { ok: false, error: err?.message || String(err) };
    } finally {
        await EcoLock.release(owner).catch(() => {});
    }

    const baseUpdate = {
        last_checked_at: new Date(),
        last_check_situation: r?.situacao || (r?.found === false ? 'NAO_ENCONTRADO' : null),
    };
    const cascadeIgnorados = () => BoletoHistory.update(
        { payment_status: 'cancelled', cancelled_at: new Date() },
        { where: { idreserva, ignorado: true, payment_status: 'pending' } }
    );

    // ── Falha técnica ────────────────────────────────────────────────────────
    if (!r || !r.ok) {
        const detalhe = r?.error || 'erro desconhecido na automação Ecobrança.';
        await EventLogger.log({
            historyId: boleto.id, idreserva, type: 'payment_check_error',
            severity: 'error', message: `Baixa por ${motivo} falhou: ${detalhe}`,
            data: { motivo, error: detalhe },
        });
        await boleto.update(baseUpdate);
        return { ok: false, outcome: 'falha', detalhe };
    }

    // ── Título não encontrado ────────────────────────────────────────────────
    if (r.found === false) {
        await EventLogger.log({
            historyId: boleto.id, idreserva, type: 'payment_check_not_found',
            severity: 'error',
            message: `Baixa por ${motivo}: Nosso Número ${boleto.nosso_numero} não encontrado no Ecobrança.`,
            data: { motivo },
        });
        await boleto.update(baseUpdate);
        return { ok: false, outcome: 'nao_encontrado', detalhe: `título ${boleto.nosso_numero} não encontrado no Ecobrança.` };
    }

    const sit = String(r.situacao || '').toUpperCase();

    // ── PAGO — não tem o que baixar; o cancelamento precisa tratar devolução ─
    if (isSituacaoPaga(sit)) {
        await EventLogger.log({
            historyId: boleto.id, idreserva, type: 'paid',
            severity: 'warning',
            message: `Baixa por ${motivo} abortada: boleto LIQUIDADO no Ecobrança (Nosso Nº ${boleto.nosso_numero}).`,
            data: { motivo, situacao: sit },
        });
        await boleto.update({ ...baseUpdate, payment_status: 'paid', paid_at: boleto.paid_at || new Date() });
        return { ok: false, outcome: 'pago', detalhe: `boleto LIQUIDADO no Ecobrança — pagamento precisa de devolução/estorno manual.` };
    }

    // ── Já estava baixado externamente ───────────────────────────────────────
    if (/BAIXAD[OA]|CANCELAD[OA]|DEVOLVID[OA]/i.test(sit)) {
        await EventLogger.log({
            historyId: boleto.id, idreserva, type: 'baixa_confirmed',
            severity: 'warning',
            message: `Baixa por ${motivo}: boleto já constava "${sit}" no Ecobrança (baixa externa). Marcado como cancelado.`,
            data: { motivo, situacao: sit, externalBaixa: true },
        });
        await boleto.update({ ...baseUpdate, payment_status: 'cancelled', cancelled_at: new Date(), last_check_situation: sit });
        await cascadeIgnorados();
        return { ok: true, outcome: 'ja_baixado', detalhe: `boleto já estava "${sit}" no Ecobrança.` };
    }

    // ── Baixa confirmada agora ───────────────────────────────────────────────
    if (r.baixaConfirmada) {
        await EventLogger.log({
            historyId: boleto.id, idreserva, type: 'baixa_confirmed',
            severity: 'success',
            message: `Baixa por devolução confirmada (${motivo}) — Nosso Nº ${boleto.nosso_numero}.`,
            data: { motivo, mensagemBaixa: r.mensagemBaixa },
        });
        await boleto.update({ ...baseUpdate, payment_status: 'cancelled', cancelled_at: new Date(), last_check_situation: 'BAIXADO' });
        await cascadeIgnorados();
        const msg = [
            '❌ Boleto do ato baixado por devolução',
            '',
            `🔢 Nosso Número: ${boleto.nosso_numero}`,
            `💰 Valor: R$ ${Number(boleto.valor || 0).toFixed(2).replace('.', ',')}`,
            boleto.vencimento ? `📅 Vencimento: ${formatDateBr(boleto.vencimento)}` : null,
            '',
            `Baixa automática solicitada pelo ${motivo} — o boleto não pode mais ser pago.`,
        ].filter(Boolean).join('\n');
        await sendCvMessageSafe(idreserva, msg, boleto.id, `baixado por ${motivo}`, ATO_STATUS.BAIXADO);
        return { ok: true, outcome: 'baixado', detalhe: `baixa por devolução confirmada no Ecobrança (Nosso Nº ${boleto.nosso_numero}).` };
    }

    // ── Baixa abortada pelo safety (situação inesperada) ─────────────────────
    const detalhe = r.abortReason
        ? `baixa abortada (safety): situação no Ecobrança era "${sit || '?'}" (${r.abortReason}).`
        : `Ecobrança não confirmou a baixa (situação "${sit || '?'}").`;
    await EventLogger.log({
        historyId: boleto.id, idreserva, type: 'baixa_aborted',
        severity: 'warning', message: `Baixa por ${motivo} não confirmada: ${detalhe}`,
        data: { motivo, abortReason: r.abortReason || null, situacao: sit },
    });
    await boleto.update(baseUpdate);
    return { ok: false, outcome: 'falha', detalhe };
}

// ── Baixa por devolução que era pagamento ─────────────────────────────────────
//
// Entre 09 e 13/08/2026 o Ecobrança devolveu "BAIXADO POR DEVOLUÇÃO" para
// títulos pagos no dia anterior, e o Office marcou o ato como cancelado. O
// acerto de 21/08 (ensureBoletoSchema) corrigiu 11 títulos do extrato daquele
// dia, mas outros ficaram cancelados. Em 14/09 a reserva 8086 voltou a "Envio
// Sienge", o gate de "ato já pago" não viu pagamento nenhum e saiu um SEGUNDO
// boleto para um ato quitado. As três funções abaixo fecham esse buraco:
//   - revalidarBaixadosPorDevolucao: reconsulta TODOS os cancelados por essa
//     situação (sem janela de dias) e promove os pagos; botão na tela.
//   - baixarDuplicatasDeAtosPagos: baixa o boleto pendente emitido DEPOIS de um
//     ato que acabou de ser reconhecido como pago.
//   - reconsultarBaixadoAntesDeEmitir: a emissão pergunta ao Ecobrança antes
//     de tratar um "baixado por devolução" como ato sem pagamento.

/**
 * Espera o lock do Ecobrança por até `tentativas` x 5 s. Devolve o owner ou
 * null se seguiu ocupado.
 */
async function esperarLock(prefixo, tentativas = 12, ttlMin = 15) {
    const owner = `${prefixo}:${new Date().toISOString()}`;
    for (let i = 0; i < tentativas; i++) {
        if (await EcoLock.acquire(owner, ttlMin)) return owner;
        await new Promise(r => setTimeout(r, 5000));
    }
    return null;
}

/**
 * Reconsulta no Ecobrança os boletos do ATO cancelados por "BAIXADO POR
 * DEVOLUÇÃO", sem limite de idade. Leitura pura: o único desfecho possível
 * é promover para pago (aplicarResultado já posta a correção no CV). Em
 * seguida baixa a cobrança duplicada de quem virou pago.
 *
 * O chamador é dono do lock do Ecobrança (controller e runner fazem como o
 * check manual). Aceita recorte por reserva ou por id do histórico.
 */
export async function revalidarBaixadosPorDevolucao({ idreservas = null, historyIds = null } = {}) {
    const settings = await BoletoSettings.findByPk(1);
    if (!settings?.eco_usuario || !settings?.eco_senha) {
        return { skipped: true, reason: 'no_eco_credentials' };
    }
    const extra = {};
    if (Array.isArray(idreservas) && idreservas.length) extra.idreserva = idreservas;
    if (Array.isArray(historyIds) && historyIds.length) extra.id = historyIds;
    const boletos = await BoletoHistory.findAll({
        where: whereBaixadosPorDevolucao(extra),
        order: [['vencimento', 'ASC'], ['id', 'ASC']],
    });
    console.log(`[BOLETO_CHECK] Revalidação de baixas por devolução: ${boletos.length} boleto(s) para reconsultar.`);
    if (!boletos.length) return { total: 0, consultados: 0, pagos_corrigidos: 0, duplicatas: null, falhas: 0 };

    const { empresas, semCnpj } = await agruparPorEmpresa(boletos, () => 'consultar');
    const { results, corrigidos } = await rodarBatch(settings, empresas);
    const duplicatas = await baixarDuplicatasDeAtosPagos(corrigidos, settings);

    const stats = {
        total: boletos.length,
        sem_cnpj: semCnpj.length,
        consultados: results.filter(r => r.ok).length,
        pagos_corrigidos: corrigidos.length,
        corrigidos: corrigidos.map(h => ({ id: h.id, idreserva: h.idreserva, nosso_numero: h.nosso_numero, paid_at: h.paid_at })),
        ainda_baixados: results.filter(r => r.ok && r.found !== false && !isSituacaoPaga(r.situacao)).length,
        nao_encontrados: results.filter(r => r.ok && r.found === false).length,
        falhas: results.filter(r => !r.ok).length,
        duplicatas,
    };
    console.log('[BOLETO_CHECK] Revalidação concluída:', JSON.stringify(stats));
    return stats;
}

/**
 * Para cada ato recém-reconhecido como pago, baixa no Ecobrança o boleto do
 * ato PENDENTE emitido depois dele (a cobrança em duplicidade), marca como
 * cancelado, avisa a timeline da reserva e o cliente que recebeu o boleto.
 *
 * Roda DEPOIS do batch de leitura (sessão própria): o portal amarra uma
 * sessão por empresa e abrir outra no meio derrubaria a consulta em curso.
 * Se a duplicata também constar paga, NÃO baixa: registra pagamento em
 * duplicidade para o Financeiro devolver.
 */
export async function baixarDuplicatasDeAtosPagos(pagos, settings = null) {
    const lista = (pagos || []).filter(h => h && !h.parcela_id);
    if (!lista.length) return null;
    settings = settings || await BoletoSettings.findByPk(1);
    if (!settings?.eco_usuario || !settings?.eco_senha) return { skipped: true, reason: 'no_eco_credentials' };

    const pagoPorDuplicata = new Map(); // duplicata.id → boleto pago
    const duplicatas = [];
    for (const pago of lista) {
        const dups = await BoletoHistory.findAll({
            where: {
                idreserva: pago.idreserva,
                status: 'success',
                payment_status: 'pending',
                parcela_id: null,
                ignorado: false,
                nosso_numero: { [Op.ne]: null },
                id: { [Op.gt]: pago.id },
            },
            order: [['id', 'ASC']],
        });
        for (const d of dups) { pagoPorDuplicata.set(d.id, pago); duplicatas.push(d); }
    }
    if (!duplicatas.length) return { total: 0, baixadas: 0 };
    console.log(`[BOLETO_CHECK] ${duplicatas.length} cobrança(s) duplicada(s) de ato pago para baixar.`);

    const { empresas } = await agruparPorEmpresa(duplicatas, () => 'baixar');
    const desfechos = [];
    await rodarBatch(settings, empresas, async (r) => {
        const d = await aplicarBaixaDuplicata(r, pagoPorDuplicata.get(r.historyId));
        desfechos.push({ historyId: r.historyId, ...d });
        return null;
    });
    return {
        total: duplicatas.length,
        baixadas: desfechos.filter(x => x.outcome === 'baixada').length,
        ja_baixadas: desfechos.filter(x => x.outcome === 'ja_baixada').length,
        pagas_em_duplicidade: desfechos.filter(x => x.outcome === 'paga_em_duplicidade').length,
        falhas: desfechos.filter(x => !['baixada', 'ja_baixada', 'paga_em_duplicidade'].includes(x.outcome)).length,
        desfechos,
    };
}

async function aplicarBaixaDuplicata(r, pago) {
    const dup = r.historyId ? await BoletoHistory.findByPk(r.historyId) : null;
    if (!dup || !pago) return { outcome: 'falha', detalhe: 'registro não encontrado' };
    const idreserva = dup.idreserva;
    const pagoEm = pago.paid_at ? formatDateBr(pago.paid_at) : null;
    const refPago = `boleto #${pago.id} (Nosso Nº ${pago.nosso_numero}${pagoEm ? `, pago em ${pagoEm}` : ''})`;
    const baseUpdate = {
        last_checked_at: new Date(),
        last_check_situation: r.situacao || (r.found === false ? 'NAO_ENCONTRADO' : null),
    };

    if (!r.ok) {
        await EventLogger.log({
            historyId: dup.id, idreserva, type: 'payment_check_error', severity: 'error',
            message: `Baixa da cobrança duplicada falhou: ${r.error || 'erro desconhecido'}. O ato já está pago pelo ${refPago}.`,
            data: { duplicataDe: pago.id, error: r.error },
        });
        await dup.update(baseUpdate);
        return { outcome: 'falha', detalhe: r.error };
    }
    if (r.found === false) {
        await EventLogger.log({
            historyId: dup.id, idreserva, type: 'payment_check_not_found', severity: 'error',
            message: `Baixa da cobrança duplicada: Nosso Nº ${dup.nosso_numero} não encontrado no Ecobrança. O ato já está pago pelo ${refPago}.`,
            data: { duplicataDe: pago.id },
        });
        await dup.update(baseUpdate);
        return { outcome: 'nao_encontrada' };
    }

    const sit = String(r.situacao || '').toUpperCase();

    // O cliente pagou os DOIS: não há o que baixar, há o que devolver.
    if (isSituacaoPaga(sit)) {
        await dup.update({ ...baseUpdate, payment_status: 'paid', paid_at: dataPagamentoDaSituacao(sit) || dup.paid_at || new Date(), cancelled_at: null });
        await EventLogger.log({
            historyId: dup.id, idreserva, type: 'paid', severity: 'error',
            message: `PAGAMENTO EM DUPLICIDADE: este boleto consta "${sit}" no Ecobrança e o ato já estava pago pelo ${refPago}. O Financeiro precisa devolver um dos valores ao cliente.`,
            data: { duplicataDe: pago.id, situacao: sit, pagamentoDuplicado: true },
        });
        const msg = [
            '⚠️ Pagamento em duplicidade do ato',
            '',
            `O cliente pagou dois boletos do mesmo ato: o ${refPago} e este, Nosso Nº ${dup.nosso_numero} (${sit}).`,
            `💰 Valor de cada um: R$ ${Number(dup.valor || 0).toFixed(2).replace('.', ',')}`,
            '',
            'O segundo boleto saiu porque o primeiro havia sido marcado como baixado por devolução pelo banco. Um dos valores precisa ser devolvido ao cliente pelo Financeiro.',
        ].join('\n');
        await sendCvMessageSafe(idreserva, msg, dup.id, 'pagamento em duplicidade', ATO_STATUS.PAGO);
        return { outcome: 'paga_em_duplicidade' };
    }

    const cancelar = (situacao) => dup.update({ ...baseUpdate, payment_status: 'cancelled', cancelled_at: new Date(), last_check_situation: situacao, substitui_id: pago.id });
    const cascadeIgnorados = () => BoletoHistory.update(
        { payment_status: 'cancelled', cancelled_at: new Date() },
        { where: { idreserva, ignorado: true, payment_status: 'pending', parcela_id: null } },
    );

    if (/BAIXAD[OA]|CANCELAD[OA]|DEVOLVID[OA]/i.test(sit)) {
        await cancelar(`${sit} (duplicidade)`);
        await cascadeIgnorados();
        await EventLogger.log({
            historyId: dup.id, idreserva, type: 'baixa_confirmed', severity: 'warning',
            message: `Cobrança duplicada já constava "${sit}" no Ecobrança. Marcada como cancelada: o ato está pago pelo ${refPago}.`,
            data: { duplicataDe: pago.id, situacao: sit },
        });
        return { outcome: 'ja_baixada' };
    }

    if (r.baixaConfirmada) {
        await cancelar('BAIXADO (duplicidade)');
        await cascadeIgnorados();
        await EventLogger.log({
            historyId: dup.id, idreserva, type: 'baixa_confirmed', severity: 'success',
            message: `Cobrança em duplicidade baixada no Ecobrança (Nosso Nº ${dup.nosso_numero}). O ato já estava pago pelo ${refPago}; este boleto saiu porque aquele constava como baixado por devolução.`,
            data: { duplicataDe: pago.id, mensagemBaixa: r.mensagemBaixa || null },
        });
        const msg = [
            '❌ Cobrança em duplicidade baixada',
            '',
            `O boleto Nosso Nº ${dup.nosso_numero} (R$ ${Number(dup.valor || 0).toFixed(2).replace('.', ',')}${dup.vencimento ? `, vencimento ${formatDateBr(dup.vencimento)}` : ''}) foi baixado e não pode mais ser pago.`,
            `O ato desta reserva já estava pago pelo ${refPago}.`,
            '',
            'O boleto duplicado saiu porque o banco havia devolvido "baixado por devolução" para o boleto pago, e o Office o tratou como cancelado. Registro corrigido: o ato consta como PAGO.',
        ].join('\n');
        await sendCvMessageSafe(idreserva, msg, dup.id, 'duplicidade baixada', ATO_STATUS.PAGO);
        const aviso = await avisarClienteDuplicataBaixada(dup, pago);
        return { outcome: 'baixada', clienteAvisado: aviso.ok, clienteEmail: aviso.to || null };
    }

    await EventLogger.log({
        historyId: dup.id, idreserva, type: 'baixa_aborted', severity: 'warning',
        message: `Baixa da cobrança duplicada não confirmada: situação "${sit || '?'}" no Ecobrança${r.abortReason ? ` (${r.abortReason})` : ''}. O ato já está pago pelo ${refPago}.`,
        data: { duplicataDe: pago.id, situacao: sit, abortReason: r.abortReason || null },
    });
    await dup.update(baseUpdate);
    return { outcome: 'nao_confirmada', detalhe: sit };
}

/**
 * E-mail curto ao titular que recebeu o boleto duplicado: o boleto foi
 * cancelado, o ato já estava pago. Só se o boleto chegou a ir ao cliente.
 * WhatsApp fica de fora: não existe template aprovado para este aviso e o
 * título baixado não pode mais ser pago no banco.
 */
async function avisarClienteDuplicataBaixada(dup, pago) {
    if (!dup.cliente_email_enviado) return { ok: false, skipped: true, error: 'boleto não foi enviado ao cliente' };
    if (BoletoNotify._internal.isLocalEnvironment()) return { ok: false, skipped: true, error: 'ambiente local: envio ao cliente desligado' };
    let email = null;
    let nome = dup.titular_nome || '';
    try {
        const { data } = await apiCv.get(`/v1/comercial/reservas/${dup.idreserva}`);
        const titular = data?.[dup.idreserva]?.titular || {};
        email = BoletoNotify._internal.pickEmail(titular.email);
        nome = titular.nome || nome;
    } catch (_) {}
    if (!email) {
        await EventLogger.log({ historyId: dup.id, idreserva: dup.idreserva, type: 'client_email', severity: 'warning', message: 'Aviso de boleto duplicado não enviado: titular sem e-mail válido no CV.' });
        return { ok: false, skipped: true, error: 'sem e-mail' };
    }
    const primeiro = BoletoNotify._internal.primeiroNome(nome) || 'cliente';
    const valor = `R$ ${Number(dup.valor || 0).toFixed(2).replace('.', ',')}`;
    const pagoEm = pago.paid_at ? formatDateBr(pago.paid_at) : null;
    const body = [
        `Olá, ${primeiro}.`,
        '',
        `O boleto de ${valor}${dup.vencimento ? ` com vencimento em ${formatDateBr(dup.vencimento)}` : ''} (Nosso Número ${dup.nosso_numero}), enviado para a sua reserva no ${dup.empreendimento || 'empreendimento'}, foi cancelado e não precisa ser pago.`,
        '',
        `Ele saiu por engano: a entrada da sua reserva já está paga${pagoEm ? ` desde ${pagoEm}` : ''} (boleto ${pago.nosso_numero}). Pedimos desculpas pelo transtorno.`,
        '',
        'Se tiver qualquer dúvida, fale com o seu corretor.',
    ].join('\n');
    try {
        await sendEmail(EmailType.GENERIC_NOTIFICATION, email, {
            title: 'Boleto cancelado: a entrada da sua reserva já está paga',
            preview: `O boleto de ${valor} foi cancelado. Sua entrada já está paga.`,
            body,
        });
        await EventLogger.log({ historyId: dup.id, idreserva: dup.idreserva, type: 'client_email', severity: 'success', message: `Aviso de boleto duplicado cancelado enviado para ${email}.` });
        return { ok: true, to: email };
    } catch (err) {
        await EventLogger.log({ historyId: dup.id, idreserva: dup.idreserva, type: 'client_email', severity: 'error', message: `Falha enviando aviso de boleto duplicado para ${email}: ${err?.message || err}` });
        return { ok: false, to: email, error: err?.message };
    }
}

/**
 * Antes de emitir uma cobrança nova do ato: se o último boleto do ato da
 * reserva foi cancelado por "BAIXADO POR DEVOLUÇÃO", pergunta ao Ecobrança
 * como ele está HOJE. Se constar pago, aplicarResultado promove para `paid`
 * (e posta a correção no CV); o gate de "ato já pago" da emissão então
 * encontra o pagamento e não cobra de novo.
 *
 * Toma e devolve o próprio lock do Ecobrança (a emissão pega o dela depois).
 * Nunca lança: falha de leitura vira `{ consultado: false, erro }` e a
 * emissão decide seguir - a rodada diária reconsulta de novo.
 */
export async function reconsultarBaixadoAntesDeEmitir(idreserva, { historyId = null } = {}) {
    const suspeito = await BoletoHistory.findOne({
        where: whereBaixadosPorDevolucao({ idreserva, ...(historyId ? { id: { [Op.ne]: historyId } } : {}) }),
        order: [['id', 'DESC']],
    });
    if (!suspeito) return { consultado: false, motivo: 'sem boleto baixado por devolução' };

    const settings = await BoletoSettings.findByPk(1);
    if (!settings?.eco_usuario || !settings?.eco_senha) return { consultado: false, boleto: suspeito, erro: 'credenciais do Ecobrança não configuradas' };

    const owner = await esperarLock(`check:pre-emissao:res=${idreserva}:hist=${suspeito.id}`);
    if (!owner) return { consultado: false, boleto: suspeito, erro: 'Ecobrança ocupado (lock)' };
    try {
        const { empresas } = await agruparPorEmpresa([suspeito], () => 'consultar');
        const { results, corrigidos } = await rodarBatch(settings, empresas);
        const r = results[0] || null;
        await suspeito.reload();
        return {
            consultado: !!r?.ok,
            boleto: suspeito,
            pago: suspeito.payment_status === 'paid' || corrigidos.length > 0,
            situacao: r?.situacao || (r?.found === false ? 'NAO_ENCONTRADO' : null),
            erro: r && !r.ok ? (r.error || 'falha na consulta') : (r ? null : 'sem resultado'),
        };
    } finally {
        await EcoLock.release(owner).catch(() => {});
    }
}

export default { runDailyCheck, baixarBoletoPorCancelamento, revalidarBaixadosPorDevolucao, baixarDuplicatasDeAtosPagos, reconsultarBaixadoAntesDeEmitir };

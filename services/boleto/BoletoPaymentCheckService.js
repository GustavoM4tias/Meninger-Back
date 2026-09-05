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

    // 3) Agrupa por CNPJ da empresa (busca via CV). Boletos sem CNPJ vão pro
    //    bucket "erro" e são registrados como falha de pré-condição.
    const cnpjCache = new Map();
    const semCnpj = [];
    const porEmpresa = new Map(); // cnpj → [boleto, ...]

    for (const b of boletos) {
        let idempreendimento_cv = null;
        try {
            // history não armazena idempreendimento_cv hoje — busca da reserva.
            // Caro mas inevitável; cacheado por reserva-id seria possível, mas
            // diferentes reservas têm diferentes empreendimentos.
            idempreendimento_cv = await fetchReservaIdEmpreendimento(b.idreserva);
        } catch (_) {}

        const cnpj = await fetchCnpjEmpresaCache(cnpjCache, idempreendimento_cv);
        if (!cnpj) {
            semCnpj.push(b);
            continue;
        }
        if (!porEmpresa.has(cnpj)) porEmpresa.set(cnpj, []);
        porEmpresa.get(cnpj).push(b);
    }

    if (semCnpj.length) {
        for (const b of semCnpj) {
            await EventLogger.log({
                historyId: b.id, idreserva: b.idreserva, type: 'payment_check_skipped',
                severity: 'warning', message: 'CNPJ da empresa não encontrado no CV — boleto pulado nesta rodada.',
            });
        }
    }

    // 4) Monta o batch Playwright. Pra cada boleto, decide a ação (consultar/baixar).
    const empresas = [];
    for (const [cnpj, lista] of porEmpresa) {
        const boletosBatch = lista.map(b => ({
            historyId: b.id,
            idreserva: b.idreserva,
            nossoNumero: b.nosso_numero,
            acao: decidirAcao(b, tolerancia),
            vencimento: b.vencimento,
        }));
        empresas.push({ cnpj_empresa: cnpj, boletos: boletosBatch });
    }

    console.log(`[BOLETO_CHECK] Batch montado: ${empresas.length} empresa(s), ${boletos.length - semCnpj.length} boleto(s).`);

    // 5) Roda o batch no Playwright (uma sessão Ecobrança).
    //    Envelopado em try/catch — se runEcoBatch crashar no meio (ex.: browser
    //    morto, exceção fatal no Playwright), os boletos JÁ PROCESSADOS via
    //    onResult já estão salvos no DB (cada um é aplicado imediato). O resto
    //    fica pendente pra próxima rodada — não perdemos progresso.
    let results = [];
    try {
        const out = await runEcoBatch({
            credentials: { usuario: settings.eco_usuario, senha: settings.eco_senha },
            empresas,
            onResult: async (r) => {
                try {
                    await aplicarResultado(r, {});
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

    const stats = {
        total: boletos.length,
        em_revalidacao: emRevalidacao,
        sem_cnpj: semCnpj.length,
        consultados: results.filter(r => r.ok && r.acao === 'consultar').length,
        baixas_tentadas: results.filter(r => r.ok && r.acao === 'baixar').length,
        baixas_efetuadas: results.filter(r => r.ok && r.baixaConfirmada).length,
        pagos: results.filter(r => r.ok && isSituacaoPaga(r.situacao)).length,
        falhas: results.filter(r => !r.ok).length,
    };
    console.log('[BOLETO_CHECK] Rodada concluída:', stats);
    return stats;
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
        await history.update({
            ...baseUpdate,
            payment_status: 'paid',
            paid_at: new Date(),
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
        return;
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

export default { runDailyCheck, baixarBoletoPorCancelamento };

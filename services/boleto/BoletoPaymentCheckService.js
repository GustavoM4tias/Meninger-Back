// services/boleto/BoletoPaymentCheckService.js
//
// Verifica diariamente o status dos boletos emitidos no Ecobrança e age:
//   - LIQUIDADO → marca como `paid`, muda CV pra situacao_pago_id, posta mensagem.
//   - EM ABERTO + passou da janela tolerância → faz baixa, marca `cancelled`,
//     muda CV pra situacao_baixado_id, posta mensagem.
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
import { podeConsultarHoje } from '../../lib/businessCalendar.js';
import { Op } from 'sequelize';

const { BoletoHistory, BoletoSettings } = db;

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

async function sendCvMessageSafe(idreserva, mensagem, historyId, tag) {
    try {
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

async function alterarSituacaoCvSafe(idreserva, idsituacao, historyId, tag) {
    try {
        await apiCv.post('/v1/comercial/reservas/alterar-situacao', {
            idreserva_cv: Number(idreserva),
            idsituacao_destino: Number(idsituacao),
            comentario: `Alteração automática — ${tag}`,
        });
        await EventLogger.log({
            historyId, idreserva, type: 'cv_situation_changed',
            severity: 'success', message: `Situação CV alterada para ${idsituacao} (${tag})`,
        });
        return { ok: true };
    } catch (err) {
        const detail = err?.response?.data?.error || err?.response?.data?.mensagem || err.message;
        await EventLogger.log({
            historyId, idreserva, type: 'cv_situation_failed',
            severity: 'error', message: `Falha mudando situação pra ${idsituacao} (${tag}): ${detail}`,
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
    const situacaoPagoId = settings.situacao_pago_id || 28;
    const situacaoBaixadoId = settings.situacao_baixado_id || 29;

    if (!settings.eco_usuario || !settings.eco_senha) {
        console.warn('[BOLETO_CHECK] Credenciais Ecobrança não configuradas — abortando.');
        return { skipped: true, reason: 'no_eco_credentials' };
    }

    // 2) Boletos elegíveis: status='success' (emitidos), payment_status='pending',
    //    com vencimento e nosso_numero válidos.
    //    Permite filtrar por idreservas pra debug/reprocessamento manual.
    const where = {
        status: 'success',
        payment_status: 'pending',
        nosso_numero: { [Op.ne]: null },
        vencimento: { [Op.ne]: null },
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

    console.log(`[BOLETO_CHECK] ${boletos.length} boleto(s) pendentes pra verificar.`);

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
    const { results } = await runEcoBatch({
        credentials: { usuario: settings.eco_usuario, senha: settings.eco_senha },
        empresas,
        onResult: async (r) => {
            // Aplica resultado de cada boleto IMEDIATAMENTE (não espera o batch
            // terminar). Em caso de crash do scheduler, já processamos parte.
            try {
                await aplicarResultado(r, { situacaoPagoId, situacaoBaixadoId });
            } catch (err) {
                console.error(`[BOLETO_CHECK] aplicarResultado falhou (hist ${r.historyId}): ${err.message}`);
            }
        },
    });

    const stats = {
        total: boletos.length,
        sem_cnpj: semCnpj.length,
        consultados: results.filter(r => r.ok && r.acao === 'consultar').length,
        baixas_tentadas: results.filter(r => r.ok && r.acao === 'baixar').length,
        baixas_efetuadas: results.filter(r => r.ok && r.baixaConfirmada).length,
        pagos: results.filter(r => r.ok && /LIQUIDAD/i.test(r.situacao || '')).length,
        falhas: results.filter(r => !r.ok).length,
    };
    console.log('[BOLETO_CHECK] Rodada concluída:', stats);
    return stats;
}

/**
 * Aplica o resultado de UM boleto: registra evento, atualiza history, dispara
 * mudança de situação + mensagem no CV quando aplicável.
 */
async function aplicarResultado(r, { situacaoPagoId, situacaoBaixadoId }) {
    if (!r.historyId) return;
    const history = await BoletoHistory.findByPk(r.historyId);
    if (!history) return;

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
    if (r.found === false) {
        await EventLogger.log({
            historyId: history.id, idreserva: history.idreserva, type: 'payment_check_not_found',
            severity: 'warning',
            message: `Nosso Número ${history.nosso_numero} não foi encontrado no Ecobrança (talvez já baixado externamente).`,
        });
        await history.update(baseUpdate);
        return;
    }

    // ── LIQUIDADO ────────────────────────────────────────────────────────────
    if (/LIQUIDAD/i.test(r.situacao || '')) {
        if (history.payment_status === 'paid') {
            // Já estava marcado — não faz nada, só atualiza last_checked.
            await history.update(baseUpdate);
            return;
        }
        await EventLogger.log({
            historyId: history.id, idreserva: history.idreserva, type: 'paid',
            severity: 'success', message: `Boleto LIQUIDADO no Ecobrança (Nosso Nº ${history.nosso_numero}).`,
            data: { situacao: r.situacao, dados: r.dados || null },
        });
        await history.update({
            ...baseUpdate,
            payment_status: 'paid',
            paid_at: new Date(),
        });
        const msg = [
            '✅ Boleto pago!',
            '',
            `🔢 Nosso Número: ${history.nosso_numero}`,
            `💰 Valor: R$ ${Number(history.valor || 0).toFixed(2).replace('.', ',')}`,
            history.vencimento ? `📅 Vencimento: ${formatDateBr(history.vencimento)}` : null,
            `🏦 Situação no Ecobrança: ${r.situacao}`,
            '',
            'Detecção automática pelo scheduler diário.',
        ].filter(Boolean).join('\n');
        await sendCvMessageSafe(history.idreserva, msg, history.id, 'pago');
        if (situacaoPagoId) await alterarSituacaoCvSafe(history.idreserva, situacaoPagoId, history.id, 'pago');
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
        await sendCvMessageSafe(history.idreserva, msg, history.id, 'baixado');
        if (situacaoBaixadoId) await alterarSituacaoCvSafe(history.idreserva, situacaoBaixadoId, history.id, 'baixado');
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

export default { runDailyCheck };

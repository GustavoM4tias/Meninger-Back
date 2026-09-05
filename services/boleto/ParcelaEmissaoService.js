// services/boleto/ParcelaEmissaoService.js
//
// Emite (e reemite) o boleto de UMA parcela mensal, baixa o boleto vivo de uma
// parcela quando o plano encerra e aplica o resultado da rodada diaria de
// verificacao (BoletoPaymentCheckService) quando o boleto e de parcela.
//
// Reaproveita os primitivos do ato (BoletoGenerationService._primitivos): mesmo
// validador de titular, mesmo calculo de nosso numero, mesmo lock do Ecobranca,
// mesmo Playwright, mesmo upload, mesmo anexo no CV, mesma mensagem na reserva.
// O que muda e o conteudo ("parcela 3 de 60") e a comunicacao com o cliente.
//
// O boleto mora em boleto_history com `tipo='parcela'` e `parcela_id`: a rodada
// das 08h (pagamento/baixa) enxerga a parcela como enxerga o ato.
import db from '../../models/sequelize/index.js';
import apiCv from '../../lib/apiCv.js';
import { Op } from 'sequelize';
import { runEcoCobrancaBoleto } from '../../playwright/services/ecocobrancaService.js';
import { runEcoBatch } from '../../playwright/services/ecoCheckService.js';
import { validateTitular, formatTitularErrorsMessage } from './titularValidator.js';
import EventLogger from './BoletoEventLogger.js';
import EcoLock from './BoletoEcoLockService.js';
import { _primitivos } from './BoletoGenerationService.js';
import { sendParcelaToTitular, sendLembrete, sendAvisoAtraso } from './ParcelaNotifyService.js';
import { isSituacaoPaga } from './BoletoPaymentCheckService.js';
import {
    PARCELA_STATUS, PLANO_STATUS, condicaoDeEmissao, descricaoParcela, rotuloParcela, hojeYmd, diffDays,
} from '../../lib/atoParcelas.js';
import { cfgParcelas, getSettings, carregarReservaCv, criarOuSincronizarPlano } from './AtoParcelaService.js';

const { AtoPlano, AtoParcela, BoletoHistory } = db;
const { acquireEcoLockWithWait, formatCurrency, formatDate, sendCvMessage, uploadToSupabase, attachToCV } = _primitivos;

/** Primeira linha das mensagens de parcela na reserva (mesmo papel do STATUS DO ATO). */
function comStatusParcela(status, p, corpo) {
    return `PARCELA ${rotuloParcela(p)} ${status}\n\n${corpo}`;
}

async function cnpjDoEmpreendimento(idempreendimento) {
    const resp = await apiCv.get(`/v1/cadastros/empreendimentos/${idempreendimento}`, { params: { limite_dados_unidade: 1 } });
    return resp.data?.cnpj_empesa || null;
}

// ── Emissão ───────────────────────────────────────────────────────────────────

/**
 * Emite o boleto da parcela. Nunca lanca: devolve { ok, history?, erro?, skipped? }.
 *
 * @param {number} parcelaId
 * @param {object} [opts]
 * @param {boolean} [opts.forcar]   acao deliberada da tela: ignora `parcelas_ativo` e a janela
 * @param {number}  [opts.userId]
 * @param {object}  [opts.settings]
 */
export async function emitirParcela(parcelaId, opts = {}) {
    const settings = opts.settings || await getSettings();
    const cfg = cfgParcelas(settings);
    const tag = `[PARCELA][parcela ${parcelaId}]`;

    const parcela = await AtoParcela.findByPk(parcelaId);
    if (!parcela) return { ok: false, erro: 'Parcela nao encontrada.' };
    const plano = await AtoPlano.findByPk(parcela.plano_id);
    if (!plano) return { ok: false, erro: 'Plano nao encontrado.' };
    const idreserva = Number(parcela.idreserva);

    if (!settings.active) return { ok: false, skipped: true, erro: 'Modulo de boleto desativado nas configuracoes.' };
    if (!settings.eco_usuario || !settings.eco_senha) return { ok: false, skipped: true, erro: 'Credenciais do Ecobranca nao configuradas.' };
    if (!cfg.ativo && !opts.forcar) return { ok: false, skipped: true, erro: 'Cobranca de parcelas pausada (parcelas_ativo = false).' };
    if (plano.status !== PLANO_STATUS.ATIVO && !opts.forcar) return { ok: false, skipped: true, erro: `Plano ${plano.status}.` };
    if (![PARCELA_STATUS.PREVISTA, PARCELA_STATUS.VENCIDA, PARCELA_STATUS.ERRO].includes(parcela.status)) {
        return { ok: false, skipped: true, erro: `Parcela ${parcela.status} - nao cabe emissao.` };
    }
    // Ja existe boleto vivo desta parcela? Reemitir por cima duplicaria a cobranca.
    const vivo = await BoletoHistory.findOne({
        where: { parcela_id: parcela.id, status: 'success', payment_status: 'pending', ignorado: false },
        order: [['id', 'DESC']],
    });
    if (vivo && !opts.forcar) return { ok: false, skipped: true, erro: `Ja existe boleto pendente (#${vivo.id}, Nosso Numero ${vivo.nosso_numero}).` };

    // Reserva ao vivo: titular, unidade e a condicao de hoje. Cancelou? Encerra.
    let reserva;
    try {
        reserva = await carregarReservaCv(idreserva);
    } catch (err) {
        return { ok: false, erro: `CV indisponivel: ${err.message}` };
    }
    if (reserva.data_cancelamento || reserva.data_distrato) {
        const { encerrarPlano } = await import('./AtoParcelaService.js');
        await encerrarPlano(plano, 'reserva_cancelada', { detalhe: `cancelada no CV em ${reserva.data_cancelamento || reserva.data_distrato}` });
        return { ok: false, skipped: true, erro: 'Reserva cancelada no CV - plano cancelado.' };
    }
    // Sincroniza previstas com o CV antes de emitir (valor pode ter mudado).
    try {
        await criarOuSincronizarPlano(idreserva, { reservaCv: reserva, settings });
        await parcela.reload();
    } catch (err) {
        console.warn(`${tag} sincronizacao com o CV falhou (segue com o gravado): ${err.message}`);
    }
    if (parcela.status === PARCELA_STATUS.TRANSFERIDA || parcela.status === PARCELA_STATUS.CANCELADA) {
        return { ok: false, skipped: true, erro: `Parcela ${parcela.status} depois da sincronizacao.` };
    }

    const { titular, unidade } = reserva;
    const hoje = hojeYmd();
    const cond = condicaoDeEmissao(parcela, {
        hoje, prazoVencidaDias: cfg.prazoVencidaDias, cobrarEncargos: cfg.atrasoCobrarEncargos,
        multaPct: cfg.atrasoMultaPct, jurosMesPct: cfg.atrasoJurosMesPct,
    });
    const reemissao = (Number(parcela.emissoes) || 0) > 0;
    const p = { numero: parcela.numero, total: parcela.total };

    const history = await BoletoHistory.create({
        idreserva, status: 'processing', tipo: 'parcela', parcela_id: parcela.id,
        idpessoa_cv: titular?.idpessoa_cv || null, titular_nome: titular?.nome || null,
        empreendimento: unidade?.empreendimento || null,
        valor: cond.valor, valor_original: Number(parcela.valor), vencimento: cond.vencimento,
    });
    const warnings = [];
    const pushWarn = (r, etapa) => { if (!r?.ok) warnings.push({ etapa, erro: r?.error || 'erro', ...(r?.skipped ? { skipped: true } : {}) }); return !!r?.ok; };

    const falhar = async (mensagemErro, { msgCv = null, seguroRepetir = false } = {}) => {
        const msgOk = msgCv ? pushWarn(await sendCvMessage(idreserva, comStatusParcela('DIVERGENTE', p, msgCv)), 'cv_mensagem') : false;
        await history.update({ status: 'error', error_message: mensagemErro, cv_mensagem_enviada: msgOk, warnings: warnings.length ? warnings : null }).catch(() => {});
        // Falha antes de escrever no banco (portal fora, lock) nao "queima" a
        // parcela: ela continua no status anterior e a proxima rodada tenta.
        if (!seguroRepetir) {
            await parcela.update({ status: PARCELA_STATUS.ERRO, erro_mensagem: mensagemErro, tentativas_erro: (parcela.tentativas_erro || 0) + 1 });
        } else {
            await parcela.update({ erro_mensagem: mensagemErro, tentativas_erro: (parcela.tentativas_erro || 0) + 1 });
        }
        console.warn(`${tag} falhou: ${mensagemErro}`);
        return { ok: false, erro: mensagemErro, history };
    };

    try {
        // Titular: o portal recusa endereco/CEP malformado - mesmo validador do ato.
        const check = validateTitular(titular);
        if (!check.valid) {
            return await falhar(
                `Divergencia nos dados do titular: ${check.errors.map(e => e.campo).join(', ')}.`,
                { msgCv: `${formatTitularErrorsMessage(check.errors)}\n\nA ${descricaoParcela(p)} nao foi emitida. Corrija o cadastro do cliente no CV; a proxima rodada tenta de novo.` },
            );
        }
        // Teto de valor do modulo (o mesmo do ato).
        if (cfg.valorMaximo && cond.valor > cfg.valorMaximo) {
            return await falhar(`Valor ${formatCurrency(cond.valor)} excede o teto de ${formatCurrency(cfg.valorMaximo)}.`,
                { msgCv: `A ${descricaoParcela(p)} (${formatCurrency(cond.valor)}) excede o teto de ${formatCurrency(cfg.valorMaximo)} configurado. Confira a condicao no CV.` });
        }

        const idempreendimento = unidade?.idempreendimento_cv;
        if (!idempreendimento) return await falhar('idempreendimento_cv nao encontrado na reserva.');
        const cnpjEmpresa = plano.cnpj_empresa || await cnpjDoEmpreendimento(idempreendimento);
        if (!cnpjEmpresa) return await falhar(`CNPJ do empreendimento ${idempreendimento} nao encontrado no CV.`);
        if (!plano.cnpj_empresa) await plano.update({ cnpj_empresa: cnpjEmpresa });

        await history.update({ cnpj_empresa: cnpjEmpresa, idpessoa_cv: titular.idpessoa_cv, titular_nome: titular.nome, empreendimento: unidade.empreendimento });

        // Nosso numero: mesma sequencia do ato (conta TODOS os boletos da pessoa).
        const anteriores = await BoletoHistory.count({ where: { idpessoa_cv: titular.idpessoa_cv, id: { [Op.lt]: history.id } } });
        const nossoNumeroCalculado = `11000000${titular.idpessoa_cv}${anteriores > 0 ? String(anteriores) : ''}`;

        // Boleto vivo desta parcela (reemissao forcada pela tela): baixa antes.
        const baixaPreviaNossoNumero = vivo?.nosso_numero || null;

        const ecoOwner = `emit:parcela=${parcela.id}:hist=${history.id}:${new Date().toISOString()}`;
        const locked = await acquireEcoLockWithWait(ecoOwner, 5);
        if (!locked) {
            const e = new Error('Lock do Ecobranca ocupado por mais de 4 min.');
            e.ecoSeguroRepetir = true; e.ecoFase = 'lock';
            throw e;
        }
        let eco;
        try {
            eco = await runEcoCobrancaBoleto({
                credentials: { usuario: settings.eco_usuario, senha: settings.eco_senha },
                cnpj_empresa: cnpjEmpresa,
                idpessoa_cv: titular.idpessoa_cv,
                nossoNumero: nossoNumeroCalculado,
                vencimento: cond.vencimento,
                valor: cond.valor,
                nome: titular.nome, documento: titular.documento,
                endereco: titular.endereco, numero: titular.numero, complemento: titular.complemento || '',
                bairro: titular.bairro, cep: titular.cep, cidade: titular.cidade, estado: titular.estado,
                baixaPreviaNossoNumero,
            });
        } finally {
            await EcoLock.release(ecoOwner).catch(() => {});
        }

        if (vivo && eco.baixaPrevia?.baixaConfirmada) {
            await vivo.update({ payment_status: 'cancelled', cancelled_at: new Date(), substituido_por_id: history.id, last_check_situation: 'BAIXADO (substituido)' });
            await EventLogger.log({ historyId: vivo.id, idreserva, type: 'baixa_confirmed', severity: 'success', message: `Boleto da ${descricaoParcela(p)} baixado por substituicao - novo boleto #${history.id}.`, data: { novoHistoryId: history.id } });
        }

        const { path: supabasePath, url: supabaseUrl } = await uploadToSupabase(eco.boletoBuffer, history.id, idreserva);
        await history.update({
            boleto_supabase_path: supabasePath, boleto_supabase_url: supabaseUrl,
            nosso_numero: eco.nossoNumero, seu_numero: eco.seuNumero, substitui_id: vivo?.id || null,
        });
        await EventLogger.log({
            historyId: history.id, idreserva, type: 'emitted', severity: 'success',
            message: `Boleto da ${descricaoParcela(p)} emitido no Ecobranca - Nosso No ${eco.nossoNumero}${cond.encargos ? ` (com encargos de ${formatCurrency(cond.encargos.total)})` : ''}`,
            data: { parcelaId: parcela.id, numero: p.numero, total: p.total, valor: cond.valor, valorOriginal: Number(parcela.valor), vencimento: cond.vencimento, vencimentoOriginal: parcela.vencimento, encargos: cond.encargos, motivo: cond.motivo, reemissao },
        });

        const anexo = await attachToCV(idreserva, eco.boletoBuffer, settings);
        const anexado = pushWarn(anexo, 'cv_anexo');
        await EventLogger.log({ historyId: history.id, idreserva, type: anexado ? 'cv_attached' : 'cv_attach_failed', severity: anexado ? 'success' : 'warning', message: anexado ? 'Documento anexado no CV' : `Anexo no CV falhou: ${anexo.error || '?'}` });

        const envio = await sendParcelaToTitular({
            titular,
            dados: {
                empreendimento: unidade.empreendimento, unidade: unidade.unidade || unidade.bloco || '',
                descricao: descricaoParcela(p), rotulo: rotuloParcela(p),
                valor: cond.valor, valorOriginal: Number(parcela.valor), encargos: cond.encargos, reemissao,
                vencimento: cond.vencimento, nossoNumero: eco.nossoNumero, seuNumero: eco.seuNumero, boletoUrl: supabaseUrl,
            },
            historyId: history.id, pdfBuffer: eco.boletoBuffer,
        });
        if (!envio.email.ok && !envio.email.skipped) warnings.push({ etapa: 'cliente_email', erro: envio.email.error });
        if (!envio.whatsapp.ok && !envio.whatsapp.skipped) warnings.push({ etapa: 'cliente_whatsapp', erro: envio.whatsapp.error });
        await EventLogger.log({ historyId: history.id, idreserva, type: envio.email.ok ? 'client_email' : 'client_email_skipped', severity: envio.email.ok ? 'success' : 'warning', message: envio.email.ok ? `E-mail enviado para ${envio.email.to}` : `E-mail nao enviado: ${envio.email.error}` });
        await EventLogger.log({ historyId: history.id, idreserva, type: envio.whatsapp.ok ? 'client_whatsapp' : 'client_whatsapp_skipped', severity: envio.whatsapp.ok ? 'success' : 'warning', message: envio.whatsapp.ok ? `WhatsApp enviado para +${envio.whatsapp.to}` : `WhatsApp nao enviado: ${envio.whatsapp.error}` });

        const linhaValor = cond.encargos
            ? `Valor: ${formatCurrency(cond.valor)} (${formatCurrency(parcela.valor)} + ${formatCurrency(cond.encargos.total)} de multa e juros por ${cond.encargos.diasAtraso} dia(s) de atraso)`
            : `Valor: ${formatCurrency(cond.valor)}`;
        const msg = [
            reemissao ? `Boleto da ${descricaoParcela(p)} reemitido.` : `Boleto da ${descricaoParcela(p)} emitido.`,
            '',
            `Empreendimento: ${unidade.empreendimento}`,
            `Unidade: ${unidade.unidade || unidade.bloco || '-'}`,
            `Titular: ${titular.nome}`,
            linhaValor,
            `Vencimento: ${formatDate(cond.vencimento)}${cond.vencimento !== parcela.vencimento ? ` (original ${formatDate(parcela.vencimento)})` : ''}`,
            `Nosso Numero: ${eco.nossoNumero}`,
            '',
            `${anexado ? 'OK' : 'X'} Anexo no CV${anexado ? '' : `: ${anexo.error || 'falhou'}`}`,
            `${envio.email.ok ? 'OK' : (envio.email.skipped ? '-' : 'X')} E-mail${envio.email.to ? ` (${envio.email.to})` : ''}${envio.email.ok ? '' : `: ${envio.email.error}`}`,
            `${envio.whatsapp.ok ? 'OK' : (envio.whatsapp.skipped ? '-' : 'X')} WhatsApp${envio.whatsapp.to ? ` (+${envio.whatsapp.to})` : ''}${envio.whatsapp.ok ? '' : `: ${envio.whatsapp.error}`}`,
            '',
            'Cobranca do Office ate o contrato ser faturado no Sienge. A etapa da reserva nao foi alterada.',
            supabaseUrl ? `Link do boleto: ${supabaseUrl}` : null,
        ].filter(Boolean).join('\n');
        const msgOk = pushWarn(await sendCvMessage(idreserva, comStatusParcela('EMITIDA', p, msg)), 'cv_mensagem');

        await history.update({
            status: 'success', cv_mensagem_enviada: msgOk, cv_documento_anexado: anexado,
            cliente_email_enviado: envio.email.ok, cliente_whatsapp_enviado: envio.whatsapp.ok, cliente_envio_em: new Date(),
            warnings: warnings.length ? warnings : null,
        });
        await parcela.update({
            status: PARCELA_STATUS.EMITIDA, boleto_history_id: history.id,
            vencimento_cobrado: cond.vencimento, valor_cobrado: cond.valor,
            encargos_valor: cond.encargos?.total || null, encargos_detalhe: cond.encargos || null,
            emissoes: (Number(parcela.emissoes) || 0) + 1, ultima_emissao_em: new Date(),
            erro_mensagem: null, lembrete_enviado_em: null, aviso_atraso_enviado_em: null,
            updated_by: opts.userId ?? parcela.updated_by,
        });
        console.log(`${tag} OK - reserva ${idreserva}, ${descricaoParcela(p)}, ${formatCurrency(cond.valor)}, venc. ${cond.vencimento}, Nosso No ${eco.nossoNumero}.`);
        return { ok: true, history, parcela };
    } catch (err) {
        const seguro = !!err.ecoSeguroRepetir;
        return await falhar(
            `${seguro ? 'Portal Ecobranca indisponivel' : 'Falha na emissao'} (${err.ecoFase || 'geral'}): ${err.message}`,
            { seguroRepetir: seguro, msgCv: seguro ? null : `Falha ao emitir a ${descricaoParcela(p)}: ${err.message}` },
        );
    }
}

// ── Baixa de boleto vivo de parcela (plano encerrado / cancelado) ─────────────

/**
 * Baixa AGORA o boleto pendente da parcela (plano encerrou: o Sienge assume,
 * ou a reserva morreu). Nunca lanca. Devolve { ok, outcome, detalhe }.
 */
export async function baixarBoletoDaParcela(parcelaId, { motivo = 'encerramento do plano', settings = null, statusFinal = PARCELA_STATUS.TRANSFERIDA } = {}) {
    settings = settings || await getSettings();
    const parcela = await AtoParcela.findByPk(parcelaId);
    if (!parcela) return { ok: false, outcome: 'falha', detalhe: 'parcela nao encontrada' };
    const boleto = await BoletoHistory.findOne({
        where: { parcela_id: parcela.id, status: 'success', payment_status: 'pending', ignorado: false, nosso_numero: { [Op.ne]: null } },
        order: [['id', 'DESC']],
    });
    if (!boleto) {
        await parcela.update({ status: statusFinal });
        return { ok: true, outcome: 'sem_boleto', detalhe: 'nenhum boleto pendente' };
    }
    let cnpj = String(boleto.cnpj_empresa || '').replace(/\D/g, '') || null;
    if (!cnpj) {
        const plano = await AtoPlano.findByPk(parcela.plano_id);
        cnpj = String(plano?.cnpj_empresa || '').replace(/\D/g, '') || null;
    }
    if (!cnpj) return { ok: false, outcome: 'falha', detalhe: 'CNPJ da empresa nao encontrado' };

    const owner = `baixa:parcela=${parcela.id}:hist=${boleto.id}:${new Date().toISOString()}`;
    let locked = false;
    for (let i = 0; i < 12 && !locked; i++) {
        locked = await EcoLock.acquire(owner, 10);
        if (!locked) await new Promise(r => setTimeout(r, 5000));
    }
    if (!locked) return { ok: false, outcome: 'falha', detalhe: 'Ecobranca ocupado (lock)' };

    let r = null;
    try {
        const out = await runEcoBatch({
            credentials: { usuario: settings.eco_usuario, senha: settings.eco_senha },
            empresas: [{ cnpj_empresa: cnpj, boletos: [{ historyId: boleto.id, idreserva: boleto.idreserva, nossoNumero: boleto.nosso_numero, acao: 'baixar' }] }],
        });
        r = out.results?.[0] || null;
    } catch (err) {
        r = { ok: false, error: err?.message || String(err) };
    } finally {
        await EcoLock.release(owner).catch(() => {});
    }
    const p = { numero: parcela.numero, total: parcela.total };
    const base = { last_checked_at: new Date(), last_check_situation: r?.situacao || (r?.found === false ? 'NAO_ENCONTRADO' : null) };
    if (!r || !r.ok) {
        await boleto.update(base);
        await EventLogger.log({ historyId: boleto.id, idreserva: boleto.idreserva, type: 'baixa_failed', severity: 'error', message: `Baixa por ${motivo} falhou: ${r?.error || 'erro'}` });
        return { ok: false, outcome: 'falha', detalhe: r?.error || 'erro na automacao' };
    }
    const sit = String(r.situacao || '').toUpperCase();
    if (isSituacaoPaga(sit)) {
        await boleto.update({ ...base, payment_status: 'paid', paid_at: boleto.paid_at || new Date() });
        await parcela.update({ status: PARCELA_STATUS.PAGA, pago_em: parcela.pago_em || new Date() });
        return { ok: false, outcome: 'pago', detalhe: 'boleto LIQUIDADO - parcela marcada como paga' };
    }
    if (r.baixaConfirmada || /BAIXAD[OA]|CANCELAD[OA]|DEVOLVID[OA]/.test(sit) || r.found === false) {
        await boleto.update({ ...base, payment_status: 'cancelled', cancelled_at: new Date(), last_check_situation: r.baixaConfirmada ? 'BAIXADO' : (sit || 'NAO_ENCONTRADO') });
        await parcela.update({ status: statusFinal });
        await EventLogger.log({ historyId: boleto.id, idreserva: boleto.idreserva, type: 'baixa_confirmed', severity: 'success', message: `Boleto da ${descricaoParcela(p)} baixado por ${motivo}.`, data: { motivo, situacao: sit } });
        await sendCvMessage(boleto.idreserva, comStatusParcela(statusFinal === PARCELA_STATUS.TRANSFERIDA ? 'TRANSFERIDA' : 'CANCELADA', p,
            `Boleto da ${descricaoParcela(p)} (Nosso Numero ${boleto.nosso_numero}, ${formatCurrency(boleto.valor)}) baixado: ${motivo}.`
            + (statusFinal === PARCELA_STATUS.TRANSFERIDA ? '\n\nO contrato foi faturado no Sienge - daqui em diante quem cobra as parcelas e o ERP.' : ''))).catch(() => {});
        return { ok: true, outcome: 'baixado', detalhe: `baixa confirmada (${sit || 'ok'})` };
    }
    await boleto.update(base);
    return { ok: false, outcome: 'falha', detalhe: `baixa nao confirmada (situacao ${sit || '?'}${r.abortReason ? `, ${r.abortReason}` : ''})` };
}

// ── Resultado da rodada diária de verificação ────────────────────────────────

/**
 * Chamado por BoletoPaymentCheckService.aplicarResultado quando o boleto tem
 * `parcela_id`. Atualiza o boleto e a parcela; a mensagem no CV fala em
 * parcela, nao em ato.
 */
export async function aplicarResultadoParcela(r, history) {
    const parcela = await AtoParcela.findByPk(history.parcela_id);
    const p = parcela ? { numero: parcela.numero, total: parcela.total } : { numero: '?', total: '?' };
    const base = { last_checked_at: new Date(), last_check_situation: r.situacao || (r.found === false ? 'NAO_ENCONTRADO' : null) };

    if (!r.ok) {
        await EventLogger.log({ historyId: history.id, idreserva: history.idreserva, type: 'payment_check_error', severity: 'error', message: r.error || 'Erro na verificacao.' });
        await history.update(base);
        return;
    }
    if (r.found === false) {
        await EventLogger.log({ historyId: history.id, idreserva: history.idreserva, type: 'payment_check_not_found', severity: 'error', message: `Nosso Numero ${history.nosso_numero} nao encontrado no Ecobranca.` });
        await history.update({ ...base, last_check_situation: 'NAO_ENCONTRADO' });
        return;
    }
    const sit = String(r.situacao || '').toUpperCase();

    if (isSituacaoPaga(sit)) {
        if (history.payment_status === 'paid') { await history.update(base); return; }
        await history.update({ ...base, payment_status: 'paid', paid_at: new Date(), cancelled_at: null });
        await EventLogger.log({ historyId: history.id, idreserva: history.idreserva, type: 'paid', severity: 'success', message: `Boleto da ${descricaoParcela(p)} pago - situacao "${r.situacao}".`, data: { situacao: r.situacao } });
        if (parcela) await parcela.update({ status: PARCELA_STATUS.PAGA, pago_em: new Date(), boleto_history_id: history.id });
        await sendCvMessage(history.idreserva, comStatusParcela('PAGA', p, [
            `Boleto da ${descricaoParcela(p)} pago.`, '',
            `Nosso Numero: ${history.nosso_numero}`, `Valor: ${formatCurrency(history.valor)}`,
            history.vencimento ? `Vencimento: ${formatDate(history.vencimento)}` : null,
            `Situacao no Ecobranca: ${r.situacao}`, '', 'Deteccao automatica pela rodada diaria.',
        ].filter(Boolean).join('\n'))).catch(() => {});
        return;
    }

    const isBaixado = /BAIXAD[OA]|CANCELAD[OA]|DEVOLVID[OA]/.test(sit) || !!r.baixaConfirmada;
    if (isBaixado && history.payment_status === 'paid') { await history.update(base); return; }
    if (isBaixado && history.payment_status === 'cancelled') { await history.update(base); return; }
    if (isBaixado) {
        await history.update({ ...base, payment_status: 'cancelled', cancelled_at: new Date(), last_check_situation: r.baixaConfirmada ? 'BAIXADO' : sit });
        await EventLogger.log({ historyId: history.id, idreserva: history.idreserva, type: 'baixa_confirmed', severity: r.baixaConfirmada ? 'success' : 'warning', message: r.baixaConfirmada ? `Boleto da ${descricaoParcela(p)} vencido sem pagamento - baixa por devolucao.` : `Boleto da ${descricaoParcela(p)} consta "${sit}" no Ecobranca (baixa externa).`, data: { situacao: sit } });
        // Plano vivo: a parcela volta para a fila como VENCIDA (a rodada de
        // parcelas decide reemitir). Plano morto: ja foi tratada no encerramento.
        if (parcela && [PARCELA_STATUS.EMITIDA, PARCELA_STATUS.ERRO].includes(parcela.status)) {
            await parcela.update({ status: PARCELA_STATUS.VENCIDA });
        }
        await sendCvMessage(history.idreserva, comStatusParcela('VENCIDA', p, [
            `Boleto da ${descricaoParcela(p)} venceu sem pagamento e foi baixado.`, '',
            `Nosso Numero: ${history.nosso_numero}`, `Valor: ${formatCurrency(history.valor)}`,
            history.vencimento ? `Vencimento: ${formatDate(history.vencimento)}` : null, '',
            'A rodada de parcelas do Office decide a reemissao (com multa e juros, se configurado).',
        ].filter(Boolean).join('\n'))).catch(() => {});
        return;
    }
    if (r.acao === 'baixar' && r.abortReason) {
        await EventLogger.log({ historyId: history.id, idreserva: history.idreserva, type: 'baixa_aborted', severity: 'warning', message: `Baixa abortada - situacao "${sit || '?'}" (${r.abortReason}).` });
        await history.update(base);
        return;
    }
    await EventLogger.log({ historyId: history.id, idreserva: history.idreserva, type: 'payment_check', severity: 'info', message: `Boleto da ${descricaoParcela(p)} ainda ${r.situacao || 'pendente'}.` });
    await history.update(base);
}

// ── Lembretes e avisos ────────────────────────────────────────────────────────

/**
 * Lembrete D-N (parcela emitida, boleto pendente) e aviso D+N (venceu e nao
 * pagou). Um de cada por boleto vivo. Devolve contagens.
 */
export async function enviarLembretes(cfg, { settings = null } = {}) {
    const hoje = hojeYmd();
    const stats = { lembretes: 0, avisos: 0, falhas: 0 };
    if (!cfg.ativo) return stats;
    const emitidas = await AtoParcela.findAll({
        where: { status: PARCELA_STATUS.EMITIDA, boleto_history_id: { [Op.ne]: null } },
        include: [{ model: AtoPlano, as: 'plano', where: { status: PLANO_STATUS.ATIVO }, attributes: ['id', 'idreserva', 'empreendimento', 'unidade'] }],
    });
    for (const parcela of emitidas) {
        try {
            const venc = String(parcela.vencimento_cobrado || parcela.vencimento).slice(0, 10);
            const faltam = diffDays(hoje, venc); // negativo = ja venceu
            const querLembrete = cfg.lembreteDiasAntes > 0 && !parcela.lembrete_enviado_em && faltam >= 0 && faltam <= cfg.lembreteDiasAntes;
            const querAviso = cfg.avisoAtrasoDiasDepois > 0 && !parcela.aviso_atraso_enviado_em && faltam < 0 && (-faltam) >= cfg.avisoAtrasoDiasDepois;
            if (!querLembrete && !querAviso) continue;
            const boleto = await BoletoHistory.findByPk(parcela.boleto_history_id);
            if (!boleto || boleto.payment_status !== 'pending') continue;
            const reserva = await carregarReservaCv(parcela.idreserva);
            const p = { numero: parcela.numero, total: parcela.total };
            const dados = {
                empreendimento: parcela.plano.empreendimento || reserva.unidade?.empreendimento, unidade: parcela.plano.unidade || reserva.unidade?.unidade || '',
                descricao: descricaoParcela(p), rotulo: rotuloParcela(p),
                valor: Number(parcela.valor_cobrado || parcela.valor), vencimento: venc,
                nossoNumero: boleto.nosso_numero, boletoUrl: boleto.boleto_supabase_url, reemitirAutomatico: cfg.atrasoReemitir,
            };
            if (querLembrete) {
                const r = await sendLembrete({ titular: reserva.titular, dados, historyId: boleto.id });
                await parcela.update({ lembrete_enviado_em: new Date() });
                await EventLogger.log({ historyId: boleto.id, idreserva: parcela.idreserva, type: 'reminder_sent', severity: 'info', message: `Lembrete de vencimento enviado (e-mail ${r.email.ok ? 'OK' : 'nao'}, WhatsApp ${r.whatsapp.ok ? 'OK' : 'nao'}).`, data: r });
                stats.lembretes++;
            } else if (querAviso) {
                const r = await sendAvisoAtraso({ titular: reserva.titular, dados, historyId: boleto.id });
                await parcela.update({ aviso_atraso_enviado_em: new Date() });
                await EventLogger.log({ historyId: boleto.id, idreserva: parcela.idreserva, type: 'overdue_notice_sent', severity: 'warning', message: `Aviso de atraso enviado (e-mail ${r.email.ok ? 'OK' : 'nao'}, WhatsApp ${r.whatsapp.ok ? 'OK' : 'nao'}).`, data: r });
                stats.avisos++;
            }
        } catch (err) {
            stats.falhas++;
            console.warn(`[PARCELAS] lembrete/aviso falhou na parcela ${parcela.id}: ${err.message}`);
        }
    }
    return stats;
}

export default { emitirParcela, baixarBoletoDaParcela, aplicarResultadoParcela, enviarLembretes };

// scheduler/atoParcelasScheduler.js
//
// Rodada DIARIA das parcelas mensais do Ato, na hora configurada em
// `boleto_settings.parcelas_hora_rodada` (padrao 09h Brasilia, depois da rodada
// de pagamento/baixa das 08h que e quem marca parcela como paga/vencida).
//
// O cron acorda de 10 em 10 minutos e so roda quando: e a hora certa, ainda nao
// rodou hoje (marca em `parcelas_ultima_rodada_em`, sobrevive a restart) e a
// janela de funcionamento do Ecobranca esta aberta.
//
// Ordem do ciclo (cada passo independe do anterior falhar):
//   1. adesao        reservas com ato pago e sem plano ganham um
//   2. encerramento  Sienge assumiu (titulo E venda faturada) / reserva morreu -> plano encerra, boletos vivos baixados
//   3. emissao       previstas que vencem em N dias, vencidas a reemitir (teto por rodada)
//   4. lembretes     D-N e D+N
//
// Passos 3 e 4 so com `parcelas_ativo` ligado. 1 e 2 rodam sempre: a aba
// Parcelas mostra os planos mesmo com a cobranca pausada.
import cron from 'node-cron';
import { Op } from 'sequelize';
import db from '../models/sequelize/index.js';
import Planos from '../services/boleto/AtoParcelaService.js';
import Emissao from '../services/boleto/ParcelaEmissaoService.js';
import { dentroDaJanela } from '../lib/boletoJanela.js';
import WhatsAppTemplateService from '../services/whatsapp/WhatsAppTemplateService.js';
import { TODOS as TEMPLATES_PARCELAS, LANG as TEMPLATES_LANG } from '../services/boleto/parcelaWhatsappTemplates.js';
import { classificarParaRodada, hojeYmd, ehErroDeCep, MOTIVOS_TRANSFERENCIA, PARCELA_STATUS, PLANO_STATUS } from '../lib/atoParcelas.js';
import EventLogger from '../services/boleto/BoletoEventLogger.js';

const BOOT_DELAY_MS = 120 * 1000; // depois da rodada das 08h (90 s) e do resto do boot

/**
 * Restart no meio de uma EMISSAO (deploy as 09h24 de 10/09/2026): o
 * boleto_history fica 'processing' e ninguem sabe se o portal chegou a
 * registrar o boleto. Fecha o registro como erro, deixa o motivo escrito e
 * trava a retentativa automatica da parcela (tentativas_erro = 5): alguem
 * confere no Ecobranca e usa "Emitir agora". Se a parcela ja foi reemitida por
 * uma rodada seguinte (a de 10/09 foi), so o historico ganha o evento.
 */
async function fecharEmissoesInterrompidas() {
    const presas = await db.BoletoHistory.findAll({
        where: { tipo: 'parcela', status: 'processing', createdAt: { [Op.lt]: new Date(Date.now() - 10 * 60 * 1000) } },
    });
    for (const h of presas) {
        const msg = 'Emissao interrompida por restart do servidor (deploy). O boleto PODE ter sido registrado no Ecobranca sem ficar gravado aqui: confira na Caixa antes de emitir de novo.';
        await h.update({ status: 'error', error_message: msg }).catch(() => {});
        const parcela = h.parcela_id ? await db.AtoParcela.findByPk(h.parcela_id) : null;
        let acao = 'parcela ja reemitida depois; so o historico registra';
        if (parcela && ((parcela.boleto_history_id === h.id && parcela.status === PARCELA_STATUS.EMITIDA) || [PARCELA_STATUS.PREVISTA, PARCELA_STATUS.ERRO].includes(parcela.status))) {
            await parcela.update({ status: PARCELA_STATUS.ERRO, erro_mensagem: msg, tentativas_erro: 5 }).catch(() => {});
            acao = 'parcela em erro, sem retentativa automatica (Emitir agora depois de conferir)';
        }
        await EventLogger.log({ historyId: h.id, idreserva: h.idreserva, type: 'emission_interrupted', severity: 'error', message: `${msg} ${acao}.` });
        console.warn(`[PARCELAS] emissao interrompida fechada: hist ${h.id} (reserva ${h.idreserva}) - ${acao}.`);
    }
    return presas.length;
}

const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';
const CRON_EXPR = '*/10 * * * *';
let rodando = false;

function horaBrasilia(now = new Date()) {
    const h = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(now);
    return Number(h) % 24;
}

/** O ciclo completo. `manual` ignora hora/marca do dia (botao da tela). */
export async function runCiclo({ manual = false, userId = null } = {}) {
    if (rodando) return { skipped: true, reason: 'ja_rodando' };
    rodando = true;
    const inicio = Date.now();
    const out = { hoje: hojeYmd(), manual, exclusoes: null, adesao: null, encerramentos: null, emissao: null, lembretes: null, erros: [] };
    // Historico da rodada na tabela (a tela le): nasce 'rodando' e fecha no fim.
    const rodada = await db.AtoParcelaRodada.create({ hoje: out.hoje, inicio: new Date(), status: 'rodando', manual, user_id: userId })
        .catch(err => { console.error('[PARCELAS] nao gravou a rodada:', err.message); return null; });
    try {
        const settings = await Planos.getSettings();
        const cfg = Planos.cfgParcelas(settings);
        if (!cfg.moduloAtivo) {
            out.skipped = 'modulo_inativo';
            await rodada?.update({ fim: new Date(), status: 'concluida', resultado: out }).catch(() => {});
            return out;
        }

        // 0. empreendimentos fora da cobranca (pausa/reativa; a tela tambem aplica ao salvar)
        try { out.exclusoes = await Planos.aplicarExclusoes(cfg, { userId }); }
        catch (err) { out.erros.push(`exclusoes: ${err.message}`); }

        // 1. adesao
        try { out.adesao = await Planos.aderirPendentes(cfg, { settings }); }
        catch (err) { out.erros.push(`adesao: ${err.message}`); }

        // 2. encerramentos (+ baixa dos boletos vivos)
        try {
            const enc = await Planos.verificarEncerramentos(cfg);
            out.encerramentos = { planos: enc.length, baixas: 0, baixas_falha: 0, avisos: 0, avisos_falha: 0 };
            const MOTIVO_BAIXA = {
                sienge_faturado: 'venda faturada no Sienge',
                repasse_contrato_emitido: 'contrato emitido pela Caixa (repasse no CV)',
                reserva_cancelada: 'cancelamento da reserva',
            };
            for (const e of enc) {
                for (const parcelaId of e.parcelasComBoletoVivo) {
                    const r = await Emissao.baixarBoletoDaParcela(parcelaId, {
                        motivo: MOTIVO_BAIXA[e.motivo] || e.motivo,
                        statusFinal: MOTIVOS_TRANSFERENCIA.includes(e.motivo) ? PARCELA_STATUS.TRANSFERIDA : PARCELA_STATUS.CANCELADA,
                        settings,
                    });
                    if (r.ok) out.encerramentos.baixas++; else out.encerramentos.baixas_falha++;
                }
                // Aviso ao cliente: so quando o Sienge/Caixa assumiu (nao no cancelamento).
                if (cfg.avisoEncerramento && MOTIVOS_TRANSFERENCIA.includes(e.motivo)) {
                    try {
                        const a = await Emissao.avisarEncerramento(e);
                        if (a.ok) out.encerramentos.avisos++; else out.encerramentos.avisos_falha++;
                    } catch (err) {
                        out.encerramentos.avisos_falha++;
                        console.warn(`[PARCELAS] aviso de encerramento falhou (reserva ${e.plano?.idreserva}): ${err.message}`);
                    }
                }
            }
        } catch (err) { out.erros.push(`encerramentos: ${err.message}`); }

        // 2b. boletos orfaos: parcela paga pelo boleto antigo com a nova via ainda viva
        try { out.orfaos = await Emissao.baixarOrfaos({ settings }); }
        catch (err) { out.erros.push(`orfaos: ${err.message}`); }

        // 3. emissao
        let emissaoFalhou = false;
        if (!cfg.ativo) {
            out.emissao = { skipped: 'parcelas_ativo=false' };
        } else if (!manual && !dentroDaJanela(settings)) {
            out.emissao = { skipped: 'fora_da_janela' };
        } else try {
            const stats = { candidatas: 0, emitidas: 0, reemitidas: 0, falhas: 0, puladas: 0, paradas: 0, retroativas: 0, teto: cfg.maxEmissoesRodada };
            const hoje = hojeYmd();
            const parcelas = await db.AtoParcela.findAll({
                where: { status: { [Op.in]: [PARCELA_STATUS.PREVISTA, PARCELA_STATUS.VENCIDA, PARCELA_STATUS.ERRO] } },
                include: [{ model: db.AtoPlano, as: 'plano', where: { status: PLANO_STATUS.ATIVO }, attributes: ['id'] }],
                order: [['vencimento', 'ASC'], ['id', 'ASC']],
            });
            // Parcelas em erro: no maximo 1 tentativa por dia, e desiste depois de 5.
            // O model e `underscored`: na instancia o carimbo e `updatedAt`
            // (`p.updated_at` vinha undefined e a guarda nunca segurava - a
            // rodada manual de 08/09 retentou os 19 erros do dia de novo).
            const fila = parcelas.filter(p => {
                if (p.status !== PARCELA_STATUS.ERRO) return true;
                if ((p.tentativas_erro || 0) >= 5) return false;
                // Erro de CEP com a contingencia ligada nao precisa esperar o dia
                // seguinte: a proxima rodada (ou o botao Rodar ciclo) ja resolve.
                if (cfg.cepContingenciaAtivo && ehErroDeCep(p.erro_mensagem)) return true;
                const carimbo = p.updatedAt || p.updated_at;
                return !carimbo || hojeYmd(new Date(carimbo)) !== hoje;
            });
            for (const p of fila) {
                // Uma parcela com dado quebrado nao pode derrubar a rodada das
                // outras: conta como falha e segue (a tela mostra o erro).
                let decisao;
                try { decisao = classificarParaRodada(p, cfg, hoje); }
                catch (err) {
                    stats.falhas++;
                    console.warn(`[PARCELAS] parcela ${p.id} (reserva ${p.idreserva}) nao classificada: ${err.message}`);
                    await p.update({ erro_mensagem: `Rodada: ${err.message}` }).catch(() => {});
                    continue;
                }
                // RETROATIVO: vencimento original antes do corte configurado nao e
                // tocado pela rodada (nem emissao nem reemissao). Fica na tela como
                // atraso, para trabalho manual pelo botao "Emitir agora".
                if (decisao === 'retroativa') { stats.retroativas++; continue; }
                if (decisao === 'aguardar') continue;
                if (decisao === 'parar') { stats.paradas++; continue; }
                // Parcela vencida na adesao com politica 'ignorar': nao emite.
                if (decisao === 'pulada') { stats.puladas++; continue; }
                stats.candidatas++;
                // Teto opcional (0 = sem teto: tudo que esta na janela sai HOJE).
                const feitas = stats.emitidas + stats.reemitidas + stats.falhas;
                if (cfg.maxEmissoesRodada > 0 && feitas >= cfg.maxEmissoesRodada) { stats.sobraram = (stats.sobraram || 0) + 1; continue; }
                // Fim da janela do Ecobranca: o que sobrar fica para a proxima rodada.
                if (!manual && !dentroDaJanela(settings)) { stats.fora_da_janela = (stats.fora_da_janela || 0) + 1; continue; }
                // Lotes: a cada N emissoes, pausa de X minutos. Cada emissao ja leva
                // ~1 min (login + formulario + PDF no portal); a pausa espalha o
                // envio ao cliente pelo dia em vez de uma rajada de WhatsApp.
                if (feitas > 0 && cfg.loteTamanho > 0 && feitas % cfg.loteTamanho === 0 && cfg.lotePausaMin > 0) {
                    console.log(`[PARCELAS] lote de ${cfg.loteTamanho} concluido (${feitas} no total) - pausa de ${cfg.lotePausaMin} min.`);
                    await new Promise(r => setTimeout(r, cfg.lotePausaMin * 60 * 1000));
                }
                const r = await Emissao.emitirParcela(p.id, { settings, userId });
                if (r.ok) { if (decisao === 'reemitir') stats.reemitidas++; else stats.emitidas++; }
                else if (r.skipped) stats.puladas++;
                else stats.falhas++;
            }
            out.emissao = stats;
        } catch (err) {
            // Passo inteiro caiu (banco, portal): registra e NAO marca o dia como
            // feito - o tick tenta de novo em 10 min enquanto a janela estiver aberta.
            emissaoFalhou = true;
            out.erros.push(`emissao: ${err.message}`);
            console.error('[PARCELAS] passo de emissao falhou:', err);
        }

        // 3b. templates de WhatsApp: o envio le o cache local (whatsapp_templates)
        // e a Meta aprova sem avisar. Enquanto algum template das parcelas nao
        // estiver APPROVED no cache, a rodada sincroniza sozinha (um GET) antes
        // dos avisos - sem isso o WhatsApp so voltava depois de alguem clicar
        // "sincronizar" na tela (09/09/2026).
        try {
            const pendentes = [];
            for (const t of TEMPLATES_PARCELAS) {
                const local = await WhatsAppTemplateService.getByName(t.name, TEMPLATES_LANG);
                if (String(local?.status || '').toUpperCase() !== 'APPROVED') pendentes.push(t.name);
            }
            if (pendentes.length) {
                await WhatsAppTemplateService.syncFromMeta();
                const aprovados = [];
                for (const name of pendentes) {
                    const local = await WhatsAppTemplateService.getByName(name, TEMPLATES_LANG);
                    if (String(local?.status || '').toUpperCase() === 'APPROVED') aprovados.push(name);
                }
                out.templates = { pendentes, aprovados_agora: aprovados };
                if (aprovados.length) console.log(`[PARCELAS] template(s) aprovado(s) na Meta: ${aprovados.join(', ')}`);
            }
        } catch (err) { out.erros.push(`templates: ${err.message}`); }

        // 4. lembretes/avisos
        try { out.lembretes = await Emissao.enviarLembretes(cfg, { settings }); }
        catch (err) { out.erros.push(`lembretes: ${err.message}`); }

        if (!emissaoFalhou) await settings.update({ parcelas_ultima_rodada_em: new Date() }).catch(() => {});
        out.duracao_s = Math.round((Date.now() - inicio) / 1000);
        console.log('[PARCELAS] Rodada concluida:', JSON.stringify(out));
        await rodada?.update({
            fim: new Date(), status: out.erros.length ? 'com_erros' : 'concluida', duracao_s: out.duracao_s,
            adesoes: Number(out.adesao?.criados ?? out.adesao?.criado ?? 0) || 0,
            encerramentos: Number(out.encerramentos?.planos || 0),
            candidatas: Number(out.emissao?.candidatas || 0), emitidas: Number(out.emissao?.emitidas || 0),
            reemitidas: Number(out.emissao?.reemitidas || 0), falhas: Number(out.emissao?.falhas || 0),
            lembretes: Number(out.lembretes?.lembretes || 0), avisos: Number(out.lembretes?.avisos || 0) + Number(out.lembretes?.finais || 0),
            resultado: out, erros: out.erros.length ? out.erros : null,
        }).catch(err => console.error('[PARCELAS] nao fechou a rodada:', err.message));
        return out;
    } catch (err) {
        // Caiu antes de terminar: fica registrado onde, para a tela mostrar.
        out.duracao_s = Math.round((Date.now() - inicio) / 1000);
        await rodada?.update({ fim: new Date(), status: 'falhou', duracao_s: out.duracao_s, resultado: out, erros: [...out.erros, `ciclo: ${err.message}`] }).catch(() => {});
        throw err;
    } finally {
        rodando = false;
    }
}

async function tick() {
    try {
        const settings = await Planos.getSettings();
        const cfg = Planos.cfgParcelas(settings);
        // A partir da hora configurada, e nao so NELA: se o servidor estava em
        // deploy/restart as 09h, ou a rodada caiu (08/09/2026), o dia nao pode
        // ficar sem cobranca - o primeiro tick seguinte recupera. A janela do
        // Ecobranca (06h-23h, na tela) continua sendo checada dentro do ciclo.
        if (horaBrasilia() < cfg.horaRodada) return;
        const ultima = settings.parcelas_ultima_rodada_em ? hojeYmd(new Date(settings.parcelas_ultima_rodada_em)) : null;
        if (ultima === hojeYmd()) return;
        await runCiclo();
    } catch (err) {
        console.error('[PARCELAS] tick falhou:', err.message);
    }
}

const atoParcelasScheduler = {
    start() {
        // Em dev nao roda sozinho: emitiria boleto real a partir da maquina local.
        const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
        if (!isProd && process.env.ENABLE_ATO_PARCELAS_IN_DEV !== 'true') {
            console.log('⏭️  atoParcelasScheduler desligado fora de producao (ENABLE_ATO_PARCELAS_IN_DEV=true para ligar).');
            return;
        }
        // Rodada que ficou "rodando" e de um processo que morreu no meio (deploy
        // as 09h24 de 10/09/2026 matou a rodada 4 na 33a emissao; a tela mostrava
        // "rodando" para sempre). Fecha como falhou; o tick seguinte ja recuperou
        // o dia (o `boleto vivo` da parcela impede boleto duplicado).
        db.AtoParcelaRodada.update(
            { status: 'falhou', fim: new Date(), erros: ['processo reiniciado durante a rodada (deploy/restart); a rodada seguinte retoma o dia'] },
            { where: { status: 'rodando' } },
        ).then(([n]) => { if (n) console.warn(`[PARCELAS] ${n} rodada(s) interrompida(s) por restart marcada(s) como falhou.`); })
            .then(() => fecharEmissoesInterrompidas())
            .catch(err => console.warn('[PARCELAS] limpeza pos-restart falhou:', err.message));
        cron.schedule(CRON_EXPR, tick, { timezone: TIMEZONE });
        // Retomada: o dia so e marcado quando a emissao termina; subiu depois da
        // hora com o dia em aberto, roda ja (o "boleto vivo" da parcela impede
        // duplicar o que a rodada interrompida ja emitiu).
        setTimeout(() => tick().catch(() => {}), BOOT_DELAY_MS).unref?.();
        console.log(`✅ atoParcelasScheduler iniciado (${CRON_EXPR} ${TIMEZONE}; roda na hora de boleto_settings.parcelas_hora_rodada).`);
    },
    runNow: runCiclo,
    fecharEmissoesInterrompidas,
};

export default atoParcelasScheduler;

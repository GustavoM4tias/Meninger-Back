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
import { classificarParaRodada, hojeYmd, PARCELA_STATUS, PLANO_STATUS } from '../lib/atoParcelas.js';

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
    const out = { hoje: hojeYmd(), manual, adesao: null, encerramentos: null, emissao: null, lembretes: null, erros: [] };
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

        // 1. adesao
        try { out.adesao = await Planos.aderirPendentes(cfg, { settings }); }
        catch (err) { out.erros.push(`adesao: ${err.message}`); }

        // 2. encerramentos (+ baixa dos boletos vivos)
        try {
            const enc = await Planos.verificarEncerramentos(cfg);
            out.encerramentos = { planos: enc.length, baixas: 0, baixas_falha: 0 };
            for (const e of enc) {
                for (const parcelaId of e.parcelasComBoletoVivo) {
                    const r = await Emissao.baixarBoletoDaParcela(parcelaId, {
                        motivo: e.motivo === 'sienge_faturado' ? 'contrato faturado no Sienge' : 'cancelamento da reserva',
                        statusFinal: e.motivo === 'sienge_faturado' ? PARCELA_STATUS.TRANSFERIDA : PARCELA_STATUS.CANCELADA,
                        settings,
                    });
                    if (r.ok) out.encerramentos.baixas++; else out.encerramentos.baixas_falha++;
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
            const fila = parcelas.filter(p => {
                if (p.status !== PARCELA_STATUS.ERRO) return true;
                if ((p.tentativas_erro || 0) >= 5) return false;
                return !p.updated_at || String(p.updated_at.toISOString()).slice(0, 10) !== hoje;
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
            lembretes: Number(out.lembretes?.lembretes || 0), avisos: Number(out.lembretes?.avisos || 0),
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
        cron.schedule(CRON_EXPR, tick, { timezone: TIMEZONE });
        console.log(`✅ atoParcelasScheduler iniciado (${CRON_EXPR} ${TIMEZONE}; roda na hora de boleto_settings.parcelas_hora_rodada).`);
    },
    runNow: runCiclo,
};

export default atoParcelasScheduler;

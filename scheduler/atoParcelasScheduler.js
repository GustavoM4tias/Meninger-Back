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
//   2. encerramento  Sienge faturou / reserva morreu -> plano encerra, boletos vivos baixados
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
import { decidirParcela, hojeYmd, PARCELA_STATUS, PLANO_STATUS } from '../lib/atoParcelas.js';

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
    try {
        const settings = await Planos.getSettings();
        const cfg = Planos.cfgParcelas(settings);
        if (!cfg.moduloAtivo) { out.skipped = 'modulo_inativo'; return out; }

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

        // 3. emissao
        if (!cfg.ativo) {
            out.emissao = { skipped: 'parcelas_ativo=false' };
        } else if (!manual && !dentroDaJanela(settings)) {
            out.emissao = { skipped: 'fora_da_janela' };
        } else {
            const stats = { candidatas: 0, emitidas: 0, reemitidas: 0, falhas: 0, puladas: 0, paradas: 0, teto: cfg.maxEmissoesRodada };
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
                const decisao = decidirParcela(p, cfg);
                if (decisao === 'aguardar') continue;
                if (decisao === 'parar') { stats.paradas++; continue; }
                // Parcela vencida na adesao com politica 'ignorar': nao emite.
                if (p.status === PARCELA_STATUS.PREVISTA && (p.emissoes || 0) === 0 && cfg.vencidasNaAdesao === 'ignorar' && p.vencimento < hoje) { stats.puladas++; continue; }
                stats.candidatas++;
                if (stats.emitidas + stats.reemitidas + stats.falhas >= cfg.maxEmissoesRodada) continue;
                const r = await Emissao.emitirParcela(p.id, { settings, userId });
                if (r.ok) { if (decisao === 'reemitir') stats.reemitidas++; else stats.emitidas++; }
                else if (r.skipped) stats.puladas++;
                else stats.falhas++;
            }
            out.emissao = stats;
        }

        // 4. lembretes/avisos
        try { out.lembretes = await Emissao.enviarLembretes(cfg, { settings }); }
        catch (err) { out.erros.push(`lembretes: ${err.message}`); }

        await settings.update({ parcelas_ultima_rodada_em: new Date() }).catch(() => {});
        out.duracao_s = Math.round((Date.now() - inicio) / 1000);
        console.log('[PARCELAS] Rodada concluida:', JSON.stringify(out));
        return out;
    } finally {
        rodando = false;
    }
}

async function tick() {
    try {
        const settings = await Planos.getSettings();
        const cfg = Planos.cfgParcelas(settings);
        if (horaBrasilia() !== cfg.horaRodada) return;
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

// scheduler/useredeConciliacaoScheduler.js
//
// Conciliação diária dos links de cartão. Espelha o boletoPaymentCheckScheduler:
// uma rodada por dia basta, porque a informação que interessa (pagou, expirou,
// foi negado) não muda de minuto em minuto.
//
// Roda às 08:10, logo depois do check do boleto (08:00), para as duas cobranças
// do ato ficarem atualizadas no mesmo horário sem disputarem o navegador.
import cron from 'node-cron';
import db from '../models/sequelize/index.js';
import { conciliar } from '../services/userede/UseredeConciliacaoService.js';

const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';
const CRON_EXPR = process.env.UREDE_CONCILIACAO_CRON || '10 8 * * *';

let rodando = false;

async function tick() {
    if (rodando) return;

    const settings = await db.UseredeSettings.findByPk(1).catch(() => null);
    if (!settings?.usuario || !settings?.senha) return;
    if (!settings.active) return;
    if (settings.session_precisa_humano) {
        console.warn('[UREDE_CONCILIACAO] Sessão aguardando intervenção humana — pulando a rodada.');
        return;
    }

    rodando = true;
    try {
        const r = await conciliar();
        console.log(`✅ [UREDE_CONCILIACAO] ${r.lidos} lido(s), ${r.atualizados} atualizado(s).`);
    } catch (err) {
        console.error('❌ [UREDE_CONCILIACAO] Falhou:', err.message);
    } finally {
        rodando = false;
    }
}

export function start() {
    cron.schedule(CRON_EXPR, tick, { timezone: TIMEZONE });
    console.log(`🕒 [UREDE_CONCILIACAO] Agendado (${CRON_EXPR}, ${TIMEZONE}).`);
}

export default { start, tick };

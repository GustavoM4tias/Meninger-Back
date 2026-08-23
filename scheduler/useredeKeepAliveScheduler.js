// scheduler/useredeKeepAliveScheduler.js
//
// Mantém viva a sessão do portal Userede (camada 2 da estratégia descrita em
// services/userede/UseredeSessionService.js).
//
// ── Por que existe ────────────────────────────────────────────────────────────
// Cada login no portal é uma chance de esbarrar no reCAPTCHA, então o objetivo é
// logar o MENOS possível. A sessão morre por inatividade - foi observado cair em
// menos de uma hora com uso leve. Tocar a sessão de tempos em tempos evita a
// maioria dos relogins.
//
// ── Deliberado: NÃO loga ──────────────────────────────────────────────────────
// `tocarSessao` usa `permitirLogin: false`. Se a sessão caiu, ele só sinaliza -
// relogar é caro e deve acontecer quando há trabalho real a fazer (uma emissão),
// não numa varredura de manutenção às 3 da manhã.
//
// ── Só roda quando faz sentido ────────────────────────────────────────────────
// Sem credencial cadastrada ou com a automação desligada, nem abre o navegador:
// cada rodada custa um Chromium.
import cron from 'node-cron';
import db from '../models/sequelize/index.js';
import { tocarSessao } from '../services/userede/UseredeSessionService.js';

const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';
// A cada 20 min: bem abaixo da janela em que a sessão foi vista morrer, e longe
// o suficiente para não pesar (cada toque sobe um browser por ~20s).
const CRON_EXPR = process.env.UREDE_KEEPALIVE_CRON || '*/20 * * * *';

let rodando = false;

async function tick() {
    // Trava simples de processo: uma rodada pode levar ~20s e o cron não deve
    // empilhar. O lock não precisa ser distribuído - o pior caso é uma sessão
    // tocada duas vezes.
    if (rodando) return;

    const settings = await db.UseredeSettings.findByPk(1).catch(() => null);
    if (!settings?.usuario || !settings?.senha) return;   // nada cadastrado
    if (!settings.active) return;                          // automação pausada
    if (!settings.session_state) return;                   // nunca logou: nada a manter
    if (settings.session_precisa_humano) return;           // esperando alguém; não insistir

    rodando = true;
    try {
        const r = await tocarSessao();
        if (!r.ok) {
            console.warn(`⚠️  [UREDE_KEEPALIVE] Sessão não respondeu: ${r.motivo}`);
        }
    } catch (err) {
        console.warn(`⚠️  [UREDE_KEEPALIVE] Falha inesperada: ${err.message}`);
    } finally {
        rodando = false;
    }
}

export function start() {
    cron.schedule(CRON_EXPR, tick, { timezone: TIMEZONE });
    console.log(`🕒 [UREDE_KEEPALIVE] Agendado (${CRON_EXPR}, ${TIMEZONE}).`);
}

export default { start, tick };

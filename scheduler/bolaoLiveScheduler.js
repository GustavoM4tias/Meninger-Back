// scheduler/bolaoLiveScheduler.js
// Poll de placar ao vivo do bolão. Roda a cada 20s, mas o tick() só faz trabalho
// real quando há jogo na janela de acompanhamento — fora disso é praticamente
// instantâneo. Um único poller no backend alimenta todos os clientes (badge +
// página), protegendo o limite do provider.

import cron from 'node-cron';
import { tick } from '../services/bolao/LiveScoreService.js';

const TZ = process.env.TIMEZONE || 'America/Sao_Paulo';
let running = false;

async function run() {
  if (running) return; // evita sobreposição se um tick demorar mais que o intervalo
  running = true;
  try {
    const n = await tick();
    if (n) console.log(`[bolaoLive] ${n} jogo(s) na janela — placar atualizado.`);
  } catch (e) {
    console.warn('[bolaoLive] erro:', e.message);
  } finally {
    running = false;
  }
}

const bolaoLiveScheduler = {
  start() {
    cron.schedule('*/20 * * * * *', run, { timezone: TZ });
    console.log('✅ bolaoLiveScheduler iniciado (poll 20s na janela dos jogos).');
  },
  runNow: run,
};

export default bolaoLiveScheduler;

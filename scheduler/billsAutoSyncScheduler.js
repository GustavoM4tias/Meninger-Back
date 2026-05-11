// scheduler/billsAutoSyncScheduler.js
//
// Auto-sync diário de bills do Sienge para todos os empreendimentos.
// Padrão: 04:00 horário de Brasília — entre o boletoCleanup (02h) e o siengeBackup (05h).
//
// Env vars:
//   - BILLS_AUTO_SYNC_CRON   (default: '0 4 * * *')
//   - BILLS_AUTO_SYNC_TZ     (default: 'America/Sao_Paulo')
//   - BILLS_AUTO_SYNC_MODE   (default: 'default') — 'default' | 'full' | 'bootstrap'

import cron from 'node-cron';
import { runAutoSync } from '../services/sienge/BillsAutoSyncService.js';

const CRON_EXP = process.env.BILLS_AUTO_SYNC_CRON || '0 4 * * *';
const TZ       = process.env.BILLS_AUTO_SYNC_TZ   || 'America/Sao_Paulo';
const MODE     = process.env.BILLS_AUTO_SYNC_MODE || 'default';

class BillsAutoSyncScheduler {
  constructor() {
    this.task = null;
  }

  start() {
    if (this.task) this.task.stop();
    this.task = cron.schedule(CRON_EXP, async () => {
      console.log(`🟦 [BillsAutoSync] Iniciando execução agendada (mode=${MODE})...`);
      try {
        const result = await runAutoSync({ mode: MODE, triggeredBy: 'cron' });
        console.log('✅ [BillsAutoSync] Execução agendada concluída.', result);
      } catch (err) {
        console.error('❌ [BillsAutoSync] Falha na execução agendada:', err?.message || err);
      }
    }, { timezone: TZ });
    console.log(`✅ BillsAutoSyncScheduler configurado: ${CRON_EXP} (${TZ}) mode=${MODE}`);
  }

  stop() {
    if (this.task) this.task.stop();
    console.log('⛔ BillsAutoSyncScheduler parado');
  }
}

export default new BillsAutoSyncScheduler();

// scheduler/siengeBackupScheduler.js
// Backup diário do banco Sienge: baixa, valida MD5, sobe descomprimido
// no bucket Oracle Cloud. Padrão: 5h da manhã (horário Brasília).

import cron from 'node-cron';
import { runDailyBackup } from '../services/sienge/SiengeBackupService.js';

const CRON_EXP = process.env.SIENGE_BACKUP_CRON || '0 5 * * *';
const TZ       = process.env.SIENGE_BACKUP_TZ   || 'America/Sao_Paulo';

class SiengeBackupScheduler {
  constructor() {
    this.task = null;
  }

  start() {
    if (this.task) this.task.stop();
    this.task = cron.schedule(CRON_EXP, async () => {
      console.log('🟦 [SiengeBackup] Iniciando backup diário...');
      try {
        const result = await runDailyBackup({ triggeredBy: 'cron' });
        console.log(`✅ [SiengeBackup] Concluído. log=${result.logId} object=${result.objectKey} size=${result.size}`);
      } catch (err) {
        console.error('❌ [SiengeBackup] Falhou:', err?.message || err);
      }
    }, { timezone: TZ });
    console.log(`✅ SiengeBackupScheduler configurado: ${CRON_EXP} (${TZ})`);
  }

  stop() {
    if (this.task) this.task.stop();
    console.log('⛔ SiengeBackupScheduler parado');
  }
}

export default new SiengeBackupScheduler();

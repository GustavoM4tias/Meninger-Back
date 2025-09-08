import cron from 'node-cron';
import landDataController from '../controllers/external/landDataController.js';

class ObstitDailyScheduler {
  constructor() {
    this.ctl = new landDataController();
    this.task = null;
    this.cronExp = process.env.LAND_CRON_EXPRESSION || '0 7 * * *';
    this.tz = process.env.OBSTIT_CRON_TZ || 'America/Sao_Paulo';
  }

  start() {
    if (this.task) this.task.stop();
    this.task = cron.schedule(this.cronExp, async () => {
      console.log('🕖 Iniciando OBSTIT sync diário...');
      // fake res para reuso do controller
      const fakeRes = { send: () => {}, status: () => ({ send: () => {} }) };
      await this.ctl.run({}, fakeRes);
    }, { timezone: this.tz });

    console.log(`✅ OBSTIT Scheduler configurado: ${this.cronExp} (${this.tz})`);
  }

  stop() {
    if (this.task) this.task.stop();
    console.log('⛔ OBSTIT Scheduler parado');
  }
}

export default new ObstitDailyScheduler();

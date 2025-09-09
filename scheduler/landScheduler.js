// src/scheduler/obstitDailyScheduler.js
import cron from 'node-cron';
import LandDataController from '../controllers/external/landDataController.js';

const ctl = new LandDataController();
const CRON_EXPR = process.env.LAND_CRON_EXPRESSION || '0 7 * * *';

export default {
  start() {
    cron.schedule(CRON_EXPR, async () => {
      console.log(`[OBSTIT Sync] Iniciando sync diário (${new Date().toISOString()})`);
      const fakeRes = { send: () => { }, status: () => ({ send: () => { } }) };
      await ctl.run({}, fakeRes);
    });

    console.log(`✅ OBSTIT Scheduler configurado: ${CRON_EXPR}`);
  }
};

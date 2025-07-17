// scheduler/contractSiengeScheduler.js
import cron from 'node-cron';
import SiengeController from '../controllers/sienge/siengeController.js';

class ContractScheduler {
    constructor() {
        this.ctl = new SiengeController();
        this.task = null;
        this.cronExp = process.env.CONTRACT_SIENGE_CRON_EXPRESSION || '0 * * * *';
    }

    start() {
        if (this.task) this.task.stop();
        this.task = cron.schedule(this.cronExp, async () => {
            console.log('🕒 Iniciando deltaSync agendado...');
            // RES FAKE completo: tem send() e status().send()
            const fakeRes = {
                send: () => { },
                status: () => ({ send: () => { } })
            };

            await this.ctl.deltaSync({}, fakeRes);
        });
        console.log(`✅ Scheduler iniciado: ${this.cronExp}`);
    }

    stop() {
        if (this.task) this.task.stop();
        console.log('⛔ Scheduler parado');
    }
}

export default new ContractScheduler();

// scheduler/contractSiengeScheduler.js
import cron from 'node-cron';
import bulkDataController from '../controllers/sienge/bulkDataController.js';

class ContractValidatorScheduler {
    constructor() {
        this.ctl = new bulkDataController();
        this.task = null;
        this.fullTask = null;
        this.cronExp = process.env.CONTRACT_SIENGE_CRON_EXPRESSION || '0 * * * *';
        // Full diário além do delta horário: o Sienge NÃO marca o contrato como
        // "modificado" em certas correções (ex.: preencher a data do contrato
        // com a instituição financeira / Crédito Associativo), então o filtro
        // modifiedAfter do delta nunca as enxerga. Só a recarga completa
        // garante que todos os campos reflitam o Sienge.
        this.fullCronExp = process.env.CONTRACT_SIENGE_FULL_CRON_EXPRESSION || '30 2 * * *';
    }

    start() {
        if (this.task) this.task.stop();
        if (this.fullTask) this.fullTask.stop();

        // RES FAKE completo: tem send() e status().send()
        const fakeRes = {
            send: () => { },
            status: () => ({ send: () => { } })
        };

        this.task = cron.schedule(this.cronExp, async () => {
            console.log('🕒 Iniciando deltaSync agendado...');
            await this.ctl.deltaSync({}, fakeRes);
        });

        this.fullTask = cron.schedule(this.fullCronExp, async () => {
            console.log('🕒 Iniciando fullSync diário de contratos...');
            await this.ctl.fullSync({}, fakeRes);
        });

        console.log(`✅ Timer de contratos Sienge configurado: delta ${this.cronExp} · full ${this.fullCronExp}`);
    }

    stop() {
        if (this.task) this.task.stop();
        if (this.fullTask) this.fullTask.stop();
        console.log('⛔ Scheduler parado');
    }
}

export default new ContractValidatorScheduler();

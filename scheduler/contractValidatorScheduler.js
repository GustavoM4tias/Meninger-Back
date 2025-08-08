// scheduler/contractValidatorScheduler.js
import cron from 'node-cron';
import ContractAutomationController from '../controllers/contractAutomationController.js';

class ContractValidatorScheduler {
    constructor() {
        this.controller = new ContractAutomationController();
        this.task = null;
        this.enabled = false;
        this.cronExpression = process.env.CONTRACT_CRON_EXPRESSION || '0 9-17 * * 1-5'; // padrão: de hora em hora, das 9h às 17h, seg a sex
    }

    start(cronExp = this.cronExpression) {
        if (this.task) {
            this.task.stop();
        }

        this.task = cron.schedule(cronExp, async () => {
            if (this.controller.isRunning) {
                console.log('⏳ Execução ainda em andamento, agendamento ignorado.');
                return;
            }

            console.log('🕒 Execução automática agendada iniciada...');
            await this.controller.executeAnalysis(
                { body: {}, method: 'SCHEDULED' },
                { status: () => ({ json: () => { } }) } // dummy res
            );
        });

        this.enabled = true;
        console.log(`✅ Timer de validação de contratos configurado:: ${cronExp}`);
    }

    stop() {
        if (this.task) {
            this.task.stop();
            this.task = null;
        }

        this.enabled = false;
        console.log('⛔ Timer parado');
    }

    restart(newCronExp) {
        this.stop();
        this.start(newCronExp);
    }

    getStatus() {
        return {
            enabled: this.enabled,
            cronExpression: this.cronExpression
        };
    }

    updateConfig({ enabled, interval }) {
        if (interval) this.cronExpression = interval;
        if (enabled) this.start(this.cronExpression);
        else this.stop();
    }
}

const contractValidatorScheduler = new ContractValidatorScheduler();
export default contractValidatorScheduler;

// | Campo         | Valor  | Significado             |
// | ------------- | ------ | ----------------------- |
// | Minuto        | `0`    | No minuto zero          |
// | Hora          | `9-17` | Das 09h às 17h          |
// | Dia do mês    | `*`    | Todos os dias           |
// | Mês           | `*`    | Todos os meses          |
// | Dia da semana | `1-5`  | Segunda (1) a sexta (5) |

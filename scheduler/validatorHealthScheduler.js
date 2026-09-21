// scheduler/validatorHealthScheduler.js
//
// Os dois relógios da saúde do Validador de Contratos:
//
//   SONDA  (padrão a cada 15 min) — um ping por modelo do pool e um GET na API
//          do validador. Barato e independente de haver contrato na fila: é o
//          que faz "nenhum contrato hoje" parar de ser indistinguível de
//          "validador morto desde a madrugada".
//
//   FILA   (padrão de hora em hora) — a mesma sonda, mais uma chamada à API do
//          CV para contar o que está preso em "Analise Contratos". Ritmo
//          próprio porque é o único item que custa chamada externa.
//
// Os dois horários vêm de `validator_settings` (tela /validator > Saúde), não
// de env: quando o ritmo precisa mudar, quem muda é quem opera, sem deploy. A
// tela chama `reload()` ao salvar, para o horário novo valer na hora.
//
// A análise de contratos continua SEM cron - quem dispara é o webhook
// CONTRATOS_IA. Isto aqui não analisa nada: só confere se daria para analisar.

import cron from 'node-cron';
import { runHealthCheck } from '../services/validator/validatorHealthService.js';
import { getSettings } from '../services/validator/validatorSettings.js';

const TZ = process.env.SCHEDULER_TZ || 'America/Sao_Paulo';

class ValidatorHealthScheduler {
    constructor() {
        this.sonda = null;
        this.fila = null;
    }

    async start() {
        this.stop();

        let settings;
        try {
            settings = await getSettings();
        } catch (err) {
            console.warn(`⚠️  ValidatorHealthScheduler: settings indisponíveis (${err.message}); usando o padrão.`);
            settings = {
                probe_enabled: true,
                probe_cron: '*/15 * * * *',
                queue_check_enabled: true,
                queue_check_cron: '7 * * * *',
            };
        }

        if (!settings.probe_enabled) {
            console.log('⛔ ValidatorHealthScheduler desligado nas configurações (a tela continua testando na mão).');
            return;
        }

        const sondaExp = settings.probe_cron || '*/15 * * * *';
        if (!cron.validate(sondaExp)) {
            console.warn(`⚠️  ValidatorHealthScheduler: cron inválido "${sondaExp}"; sonda não agendada.`);
        } else {
            this.sonda = cron.schedule(sondaExp, () => {
                runHealthCheck({ origin: 'agendado', incluirFila: false })
                    .catch(err => console.error('❌ [ValidadorSaude] sonda falhou:', err?.message || err));
            }, { timezone: TZ });
            console.log(`✅ ValidatorHealthScheduler sonda: ${sondaExp} (${TZ})`);
        }

        const filaExp = settings.queue_check_cron || '7 * * * *';
        if (settings.queue_check_enabled) {
            if (!cron.validate(filaExp)) {
                console.warn(`⚠️  ValidatorHealthScheduler: cron da fila inválido "${filaExp}"; fila não conferida.`);
            } else {
                this.fila = cron.schedule(filaExp, () => {
                    runHealthCheck({ origin: 'agendado', incluirFila: true })
                        .catch(err => console.error('❌ [ValidadorSaude] checagem de fila falhou:', err?.message || err));
                }, { timezone: TZ });
                console.log(`✅ ValidatorHealthScheduler fila do CV: ${filaExp} (${TZ})`);
            }
        }
    }

    stop() {
        if (this.sonda) { this.sonda.stop(); this.sonda = null; }
        if (this.fila) { this.fila.stop(); this.fila = null; }
    }

    /** Chamado quando a tela salva a configuração, pro novo ritmo valer já. */
    async reload() {
        await this.start();
    }
}

export default new ValidatorHealthScheduler();

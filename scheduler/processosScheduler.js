// scheduler/processosScheduler.js
//
// O RELÓGIO DO MOTOR DE PROCESSOS.
//
// Uma rotina só, de madrugada: coleta os episódios fechados do dia, grava os
// que são novos e minera o acumulado em busca de padrão.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE UMA VEZ POR DIA, E DE MADRUGADA
//
// O que se aprende aqui não muda de hora em hora - um padrão de processo leva
// semanas para aparecer, e rodar de hora em hora só multiplicaria consulta ao
// banco e chamada de IA para chegar na mesma conclusão. Às 05:00 os syncs do
// CV da noite já passaram, então os carimbos de data do dia anterior estão
// completos quando o coletor lê.
//
// O horário vem de `processo_settings` (tela > Ajustes), não de env: quando o
// ritmo precisar mudar, quem muda é quem opera, sem deploy.
//
// ─────────────────────────────────────────────────────────────────────────────
// ESTE SCHEDULER NÃO AGE
//
// Ele observa e propõe. Nenhuma ação sobre lead, reserva ou repasse sai daqui,
// em nenhum degrau de autonomia: quem executa é o processo, pelo
// `registrarAcao`, que confere degrau e escopo antes de deixar passar.

import cron from 'node-cron';
import { minerarTudo } from '../services/processos/mineracao.js';
import { getSettings } from '../services/processos/processoService.js';

const TZ = process.env.SCHEDULER_TZ || 'America/Sao_Paulo';
const PADRAO = '0 5 * * *';

class ProcessosScheduler {
    constructor() { this.job = null; }

    async start() {
        this.stop();

        let settings;
        try {
            settings = await getSettings();
        } catch (err) {
            console.warn(`⚠️  ProcessosScheduler: settings indisponíveis (${err.message}); usando o padrão.`);
            settings = { mineracao_enabled: true, mineracao_cron: PADRAO };
        }

        if (!settings.mineracao_enabled) {
            console.log('⛔ ProcessosScheduler desligado nos ajustes (a tela continua minerando na mão).');
            return;
        }

        const exp = settings.mineracao_cron || PADRAO;
        if (!cron.validate(exp)) {
            console.warn(`⚠️  ProcessosScheduler: cron inválido "${exp}"; mineração não agendada.`);
            return;
        }

        this.job = cron.schedule(exp, () => {
            minerarTudo({ seco: false })
                .catch(err => console.error('❌ [Processos] mineração falhou:', err?.message || err));
        }, { timezone: TZ });

        console.log(`✅ ProcessosScheduler mineração: ${exp} (${TZ})`);
    }

    stop() {
        if (this.job) { this.job.stop(); this.job = null; }
    }

    /** Chamado pela tela ao salvar os ajustes, para o horário valer na hora. */
    async reload() { await this.start(); }
}

export default new ProcessosScheduler();

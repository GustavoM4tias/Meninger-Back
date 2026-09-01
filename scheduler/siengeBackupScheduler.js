// scheduler/siengeBackupScheduler.js
//
// Dois relógios da carga diária do Sienge:
//   - carga:  baixa, valida MD5, restaura e promove o espelho (padrão 5h, Brasília)
//   - vigia:  de 30 em 30 min confere a IDADE DO ESPELHO e dispara se envelheceu
//
// O horário e o resto da regra vêm de `sienge_backup_settings`, e o FUSO em que
// esses horários são lidos vem de `sienge_connection_settings` — as duas abas de
// configuração da tela /settings/sienge. As env vars ficaram só como piso.
//
// Quem executa é o siengeBackupRunner, que cuida da retentativa e do aviso. E
// quem garante que só uma instância roda de cada vez é a trava em
// lib/siengeBackupLock.js — antes disso, duas instâncias disputavam o mesmo
// database de staging e derrubavam uma à outra.

import cron from 'node-cron';
import { runWithRetries, watchdogTick } from '../services/sienge/siengeBackupRunner.js';
import { getSettings } from '../services/sienge/siengeBackupSettings.js';
import { getConnection } from '../services/sienge/siengeConnection.js';

class SiengeBackupScheduler {
  constructor() {
    this.task = null;
    this.watchdog = null;
  }

  async start() {
    this.stop();

    let TZ = process.env.SIENGE_BACKUP_TZ || 'America/Sao_Paulo';
    try {
      TZ = (await getConnection()).timezone || TZ;
    } catch { /* piso do env */ }

    let settings;
    try {
      settings = await getSettings();
    } catch (err) {
      console.warn(`⚠️  SiengeBackupScheduler: settings indisponíveis (${err.message}); usando o padrão.`);
      settings = {
        active: true,
        cron_expression: process.env.SIENGE_BACKUP_CRON || '0 5 * * *',
        watchdog_enabled: true,
        watchdog_cron: '*/30 * * * *',
      };
    }

    if (!settings.active) {
      console.log('⛔ SiengeBackupScheduler desligado nas configurações (a tela continua disparando manualmente).');
      return;
    }

    const cargaExp = settings.cron_expression || '0 5 * * *';
    if (!cron.validate(cargaExp)) {
      console.warn(`⚠️  SiengeBackupScheduler: cron inválido "${cargaExp}"; carga não agendada.`);
    } else {
      this.task = cron.schedule(cargaExp, () => {
        console.log('🟦 [SiengeBackup] Iniciando carga diária...');
        runWithRetries({ triggeredBy: 'cron', attempt: 1 })
          .catch(err => console.error('❌ [SiengeBackup] runner falhou:', err?.message || err));
      }, { timezone: TZ });
      console.log(`✅ SiengeBackupScheduler configurado: ${cargaExp} (${TZ})`);
    }

    const vigiaExp = settings.watchdog_cron || '*/30 * * * *';
    if (settings.watchdog_enabled) {
      if (!cron.validate(vigiaExp)) {
        console.warn(`⚠️  SiengeBackupScheduler: cron do vigia inválido "${vigiaExp}"; vigia não agendado.`);
      } else {
        this.watchdog = cron.schedule(vigiaExp, () => {
          watchdogTick()
            .then(r => { if (r?.triggered || r?.gaveUp) console.log('[SiengeBackup vigia]', r); })
            .catch(err => console.error('❌ [SiengeBackup vigia] falhou:', err?.message || err));
        }, { timezone: TZ });
        console.log(`✅ SiengeBackupScheduler vigia de frescor: ${vigiaExp} (${TZ})`);
      }
    }
  }

  stop() {
    if (this.task) { this.task.stop(); this.task = null; }
    if (this.watchdog) { this.watchdog.stop(); this.watchdog = null; }
  }

  /** Chamado quando a tela salva a configuração, pra o novo horário valer já. */
  async reload() {
    await this.start();
  }
}

export default new SiengeBackupScheduler();

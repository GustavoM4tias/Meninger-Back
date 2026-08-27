// services/sienge/siengeBackupRunner.js
//
// Garantia de conclusão da carga diária do Sienge.
//
// O pipeline em si (SiengeBackupService) sabe fazer UMA rodada. Quem garante
// que o dia termina com o espelho fresco é este módulo, em duas camadas:
//
//   1. Retentativa escalonada: falhou a rodada, reagenda com backoff crescente
//      até o teto de tentativas ou até a hora limite do dia.
//   2. Vigia de frescor: de tempos em tempos confere a IDADE DO ESPELHO, não o
//      resultado da última rodada. É o que cobre o caso em que o container
//      morreu no meio e não sobrou ninguém pra reagendar nada.
//
// E quando o dia acaba sem carga, avisa — até aqui o log gravava a falha e a
// vida seguia, com várias telas mostrando número velho em silêncio.

import { Op } from 'sequelize';

import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';
import { runDailyBackup } from './SiengeBackupService.js';
import { getSettings, getSettingsRow } from './siengeBackupSettings.js';
import { getMirrorFreshness, isRunInProgress, brasiliaWallClockToInstant } from './siengeMirrorFreshness.js';

const TZ = process.env.SIENGE_BACKUP_TZ || 'America/Sao_Paulo';

// ─── Relógio de Brasília ──────────────────────────────────────────────────────
// O Railway roda em UTC. Sem isto, "para de tentar às 20h" viraria 17h local.

function brasiliaParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return {
    dayKey: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour) % 24,
  };
}

/** Instante em que o dia corrente começou, em Brasília, como Date absoluto. */
function startOfBrasiliaDay(date = new Date()) {
  const { dayKey } = brasiliaParts(date);
  // Brasília é UTC-3 o ano todo desde 2019 (sem horário de verão).
  return new Date(`${dayKey}T00:00:00-03:00`);
}

/**
 * `lastChange` vem sem fuso (hora de parede que o Sienge gravou). Formatar com
 * `new Date(str)` direto leria a hora no fuso do processo, e o Railway roda em
 * UTC — o aviso sairia com 3 horas de diferença.
 */
function formatMirrorDate(lastChange) {
  const d = brasiliaWallClockToInstant(lastChange);
  return d ? d.toLocaleString('pt-BR', { timeZone: TZ }) : 'data desconhecida';
}

// ─── Aviso ────────────────────────────────────────────────────────────────────

async function resolveRecipients(settings) {
  const chosen = (settings.notify_user_ids || []).map(Number).filter(Boolean);
  if (chosen.length) return chosen;

  // Ninguém escolhido na tela = todos os administradores. Um alerta que não
  // chega a ninguém é pior que não ter alerta.
  const admins = await db.User.findAll({
    where: { role: 'admin', status: true },
    attributes: ['id'],
  });
  return admins.map(u => u.id);
}

/**
 * Manda o aviso no máximo uma vez por motivo por dia. `key` carrega o dia, então
 * o mesmo problema volta a avisar amanhã se continuar.
 */
async function sendAlert({ key, title, body, link = '/settings/backup-sienge', opensAlert = true }) {
  const row = await getSettingsRow();
  if (row.last_alert_key === key) return { sent: false, reason: 'já avisado' };

  const settings = { ...row.get({ plain: true }) };
  const users = await resolveRecipients(settings);
  if (!users.length) {
    console.warn('[SiengeBackupRunner] sem destinatários para o aviso.');
    return { sent: false, reason: 'sem destinatários' };
  }

  await NotificationService.notify({
    type: NotificationType.SIENGE_BACKUP_FAILED,
    recipients: { users },
    title,
    body,
    link,
    importance: 8,
    data: { alertKey: key },
    emailData: { title, body, link },
  }).catch(err => console.warn('[SiengeBackupRunner] notify falhou:', err?.message));

  await row.update({
    last_alert_key: key,
    last_alert_at: new Date(),
    alert_open: opensAlert,
  });
  return { sent: true, users: users.length };
}

/** Fecha o aviso aberto quando a carga volta a completar. */
async function clearAlertIfOpen(freshness) {
  const row = await getSettingsRow();
  if (!row.alert_open) return;

  const users = await resolveRecipients(row.get({ plain: true }));
  if (users.length) {
    await NotificationService.notify({
      type: NotificationType.SIENGE_BACKUP_FAILED,
      recipients: { users },
      title: 'Carga do espelho do Sienge voltou ao normal',
      body: `O espelho foi restaurado e está com dado de ${formatMirrorDate(freshness?.lastChange)}.`,
      link: '/settings/backup-sienge',
      importance: 4,
      data: { recovered: true },
      emailData: {
        title: 'Carga do espelho do Sienge voltou ao normal',
        body: `O espelho foi restaurado e está com dado de ${formatMirrorDate(freshness?.lastChange)}.`,
        link: '/settings/backup-sienge',
      },
    }).catch(err => console.warn('[SiengeBackupRunner] notify de recuperação falhou:', err?.message));
  }

  await row.update({ alert_open: false, last_alert_key: null });
}

// ─── Retentativa escalonada ───────────────────────────────────────────────────

// Timer da próxima tentativa. Um por processo: a trava impede que duas
// instâncias rodem juntas, e enfileirar mais de uma tentativa não ajuda.
let _pendingRetry = null;

function cancelPendingRetry() {
  if (_pendingRetry) {
    clearTimeout(_pendingRetry);
    _pendingRetry = null;
  }
}

function backoffMinutes(settings, attempt) {
  const list = Array.isArray(settings.retry_backoff_minutes) && settings.retry_backoff_minutes.length
    ? settings.retry_backoff_minutes
    : [15, 30, 60, 120];
  // attempt = a tentativa que acabou de falhar (1-based). O último valor repete.
  return Number(list[Math.min(attempt - 1, list.length - 1)]) || 15;
}

/**
 * Roda a carga e, se falhar, reagenda sozinha.
 *
 * `attempt` é a tentativa do dia. Uma rodada dispensada pela trava não conta
 * como tentativa — quem está com a trava é que vai concluir ou falhar.
 */
export async function runWithRetries({ triggeredBy = 'cron', attempt = 1 } = {}) {
  cancelPendingRetry();

  const settings = await getSettings();

  try {
    const result = await runDailyBackup({ triggeredBy, attempt });

    if (result?.skipped) {
      console.log('[SiengeBackupRunner] rodada dispensada pela trava; quem está com ela conclui.');
      return result;
    }

    console.log(`✅ [SiengeBackupRunner] carga concluída na tentativa ${attempt} (log=${result.logId}).`);
    const freshness = await getMirrorFreshness({ force: true }).catch(() => null);
    await clearAlertIfOpen(freshness);
    return result;
  } catch (err) {
    console.error(`❌ [SiengeBackupRunner] tentativa ${attempt} falhou: ${err?.message || err}`);
    await scheduleRetryOrGiveUp({ settings, attempt, triggeredBy, err });
    return { ok: false, error: err?.message };
  }
}

async function scheduleRetryOrGiveUp({ settings, attempt, triggeredBy, err }) {
  const { hour, dayKey } = brasiliaParts();
  const maxAttempts = Number(settings.retry_max_attempts) || 5;
  const untilHour   = Number(settings.retry_until_hour);

  const waitMin = backoffMinutes(settings, attempt);
  const nextHour = brasiliaParts(new Date(Date.now() + waitMin * 60_000)).hour;

  const esgotou   = attempt >= maxAttempts;
  const foraDaJanela = hour >= untilHour || nextHour >= untilHour;

  if (esgotou || foraDaJanela) {
    const motivo = esgotou
      ? `esgotou as ${maxAttempts} tentativas do dia`
      : `passou da hora limite (${String(untilHour).padStart(2, '0')}h)`;
    console.error(`[SiengeBackupRunner] desistindo hoje: ${motivo}.`);

    if (settings.alert_on_failure) {
      const freshness = await getMirrorFreshness({ force: true }).catch(() => null);
      const desde = freshness?.lastChange
        ? `O espelho continua com dado de ${formatMirrorDate(freshness.lastChange)}.`
        : 'Não foi possível ler a data do espelho.';
      await sendAlert({
        key: `${dayKey}:falha`,
        title: 'Carga do espelho do Sienge não completou hoje',
        body: `A restauração diária falhou e ${motivo}. Último erro: ${String(err?.message || err).slice(0, 300)}. `
          + `${desde} Custos/Títulos, Recebimentos do Ato, Inadimplência e Stand de Vendas seguem mostrando esse dado.`,
      });
    }
    return;
  }

  console.log(`[SiengeBackupRunner] reagendando tentativa ${attempt + 1}/${maxAttempts} em ${waitMin} min.`);
  _pendingRetry = setTimeout(() => {
    _pendingRetry = null;
    runWithRetries({ triggeredBy, attempt: attempt + 1 })
      .catch(e => console.error('[SiengeBackupRunner] retry falhou:', e?.message || e));
  }, waitMin * 60_000);
  _pendingRetry.unref?.();
}

// ─── Vigia de frescor ─────────────────────────────────────────────────────────

/**
 * Olha a IDADE DO ESPELHO, não o resultado da última rodada.
 *
 * É essa diferença que fecha o buraco: se o container morreu no meio da carga,
 * não há log de falha, não há timer de retentativa e ninguém percebe. O que não
 * mente é a data do dado.
 */
export async function watchdogTick() {
  const settings = await getSettings();
  if (!settings.watchdog_enabled) return { skipped: 'desligado' };

  const freshness = await getMirrorFreshness({ force: true });
  if (!freshness.stale) return { ok: true, stale: false, ageHours: freshness.ageHours };

  const inProgress = await isRunInProgress();
  if (inProgress.running) {
    return { skipped: 'carga em andamento', logId: inProgress.logId };
  }
  if (_pendingRetry) {
    return { skipped: 'retentativa já agendada' };
  }
  if (inProgress.zombieLogId) {
    // Log preso em `running` sem batida: o processo morreu. Fecha pra não
    // travar a tela nem o próximo disparo.
    await db.SiengeBackupLog.update(
      {
        status: 'failed',
        finished_at: new Date(),
        error_message: `Rodada sem sinal de vida há ${inProgress.zombieSinceMinutes} min — processo encerrado fora do nosso controle (deploy/crash).`,
        import_status: 'failed',
      },
      { where: { id: inProgress.zombieLogId, status: 'running' } }
    ).catch(e => console.warn('[SiengeBackupRunner] não consegui fechar o log zumbi:', e.message));
    console.warn(`[SiengeBackupRunner] log ${inProgress.zombieLogId} fechado como falho (sem batida).`);
  }

  const { hour, dayKey } = brasiliaParts();
  const maxAttempts = Number(settings.retry_max_attempts) || 5;
  const untilHour   = Number(settings.retry_until_hour);

  // Quantas rodadas de verdade já houve hoje (skip da trava não conta).
  const runsToday = await db.SiengeBackupLog.count({
    where: {
      started_at: { [Op.gte]: startOfBrasiliaDay() },
      status: { [Op.ne]: 'skipped' },
    },
  });

  if (hour >= untilHour || runsToday >= maxAttempts) {
    if (settings.alert_on_stale) {
      await sendAlert({
        key: `${dayKey}:velho`,
        title: `Espelho do Sienge com ${Math.round(freshness.ageHours)}h de atraso`,
        body: `A carga não completou hoje (${runsToday} tentativa(s), limite de ${maxAttempts}) e o espelho passou do limite de `
          + `${freshness.staleLimitHours}h. O dado mais recente é de `
          + `${formatMirrorDate(freshness.lastChange)}.`,
      });
    }
    return { ok: false, stale: true, gaveUp: true, ageHours: freshness.ageHours, runsToday };
  }

  console.warn(`🟨 [SiengeBackupRunner] espelho com ${freshness.ageHours}h (limite ${freshness.staleLimitHours}h) e ninguém rodando — disparando carga.`);
  runWithRetries({ triggeredBy: 'watchdog', attempt: runsToday + 1 })
    .catch(e => console.error('[SiengeBackupRunner] disparo do vigia falhou:', e?.message || e));

  return { ok: true, stale: true, triggered: true, ageHours: freshness.ageHours, runsToday };
}

export default { runWithRetries, watchdogTick };

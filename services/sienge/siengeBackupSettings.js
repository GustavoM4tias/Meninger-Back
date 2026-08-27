// services/sienge/siengeBackupSettings.js
//
// Leitura e escrita da regra de operação da carga do Sienge.
//
// A tabela manda; as env vars são só o piso de quando a linha ainda não existe
// (primeiro boot, banco novo). Nunca leia process.env direto no pipeline — leia
// daqui, senão o painel deixa de valer.

import db from '../../models/sequelize/index.js';

const SETTINGS_ID = 1;

/** Piso usado quando a linha ainda não foi semeada. */
function envDefaults() {
  return {
    active: process.env.ENABLE_SIENGE_BACKUP_SCHEDULE !== 'false',
    cron_expression: process.env.SIENGE_BACKUP_CRON || '0 5 * * *',
    retry_max_attempts: 5,
    retry_backoff_minutes: [15, 30, 60, 120],
    retry_until_hour: 20,
    restore_retry_attempts: 2,
    watchdog_enabled: true,
    watchdog_cron: '*/30 * * * *',
    stale_limit_hours: 28,
    restore_jobs: Number(process.env.SIENGE_PG_RESTORE_JOBS || 2),
    restore_timeout_minutes: Math.round(
      Number(process.env.SIENGE_PG_RESTORE_TIMEOUT_MS || 90 * 60 * 1000) / 60000
    ),
    notify_user_ids: [],
    alert_on_failure: true,
    alert_on_stale: true,
    alert_open: false,
    last_alert_at: null,
    last_alert_key: null,
  };
}

/** Campos que a tela pode editar. O resto é estado do pipeline. */
const EDITABLE = [
  'active', 'cron_expression',
  'retry_max_attempts', 'retry_backoff_minutes', 'retry_until_hour', 'restore_retry_attempts',
  'watchdog_enabled', 'watchdog_cron', 'stale_limit_hours',
  'restore_jobs', 'restore_timeout_minutes',
  'notify_user_ids', 'alert_on_failure', 'alert_on_stale',
];

function clampInt(v, { min, max, fallback }) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Limites de sanidade. Não são regra de negócio escondida: são o que o pipeline
 * consegue executar. Uma rodada custa ~20 min, então `retry_backoff_minutes`
 * abaixo de 5 só empilharia tentativa em cima de tentativa.
 */
function sanitize(patch) {
  const out = {};
  for (const key of EDITABLE) {
    if (!(key in patch)) continue;
    const v = patch[key];

    switch (key) {
      case 'active':
      case 'watchdog_enabled':
      case 'alert_on_failure':
      case 'alert_on_stale':
        out[key] = Boolean(v);
        break;

      case 'cron_expression':
      case 'watchdog_cron': {
        const s = String(v || '').trim();
        if (s) out[key] = s.slice(0, 64);
        break;
      }

      case 'retry_max_attempts':      out[key] = clampInt(v, { min: 1, max: 20,  fallback: 5 });  break;
      case 'retry_until_hour':        out[key] = clampInt(v, { min: 0, max: 23,  fallback: 20 }); break;
      case 'restore_retry_attempts':  out[key] = clampInt(v, { min: 0, max: 5,   fallback: 2 });  break;
      case 'stale_limit_hours':       out[key] = clampInt(v, { min: 2, max: 240, fallback: 28 }); break;
      case 'restore_jobs':            out[key] = clampInt(v, { min: 1, max: 8,   fallback: 2 });  break;
      case 'restore_timeout_minutes': out[key] = clampInt(v, { min: 10, max: 480, fallback: 90 }); break;

      case 'retry_backoff_minutes': {
        const arr = (Array.isArray(v) ? v : [])
          .map(n => clampInt(n, { min: 5, max: 720, fallback: null }))
          .filter(n => n != null);
        if (arr.length) out[key] = arr.slice(0, 10);
        break;
      }

      case 'notify_user_ids':
        out[key] = (Array.isArray(v) ? v : []).map(Number).filter(Boolean);
        break;
    }
  }
  return out;
}

/** Linha viva (Sequelize) — para quem precisa gravar estado do alerta. */
export async function getSettingsRow() {
  const [row] = await db.SiengeBackupSettings.findOrCreate({
    where: { id: SETTINGS_ID },
    defaults: { id: SETTINGS_ID, ...envDefaults() },
  });
  return row;
}

/** Configuração em objeto simples, já com o piso das env vars aplicado. */
export async function getSettings() {
  try {
    const row = await getSettingsRow();
    return { ...envDefaults(), ...row.get({ plain: true }) };
  } catch (err) {
    // Banco fora do ar não pode impedir o pipeline de rodar com o padrão.
    console.warn('[siengeBackupSettings] caindo no padrão de env:', err.message);
    return { id: SETTINGS_ID, ...envDefaults() };
  }
}

export async function updateSettings(patch = {}, userId = null) {
  const row = await getSettingsRow();
  const clean = sanitize(patch);
  if (userId) clean.updated_by = userId;
  await row.update(clean);
  return { ...envDefaults(), ...row.get({ plain: true }) };
}

export default { getSettings, getSettingsRow, updateSettings };

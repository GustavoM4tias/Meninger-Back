// controllers/sienge/backupController.js
// Endpoints pra a UI do Menin Office consultar status dos backups do Sienge.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { runWithRetries, watchdogTick } from '../../services/sienge/siengeBackupRunner.js';
import { getMirrorFreshness } from '../../services/sienge/siengeMirrorFreshness.js';
import { getSettings, updateSettings } from '../../services/sienge/siengeBackupSettings.js';
import siengeBackupScheduler from '../../scheduler/siengeBackupScheduler.js';

/**
 * GET /sienge/backups
 * Filtro por período em `started_at` (?from=YYYY-MM-DD&to=YYYY-MM-DD). A tela
 * consulta sempre um intervalo (padrão: mês corrente) e traz tudo dele - o
 * `limit` só vale quando nenhuma data é informada, pra não devolver a tabela
 * inteira em chamadas sem filtro.
 */
export async function listBackups(req, res) {
  try {
    const status = req.query.status; // opcional: 'success' | 'failed' | 'running'
    const { from, to } = req.query;

    const where = {};
    if (status) where.status = status;

    // A tela manda instantes ISO já no fuso do usuário; se vier só a data
    // (YYYY-MM-DD), completa com os limites do dia no fuso do servidor.
    const bound = (v, end) => (String(v).includes('T')
      ? new Date(v)
      : new Date(`${v}T${end ? '23:59:59.999' : '00:00:00'}`));

    const range = {};
    if (from) range[Op.gte] = bound(from, false);
    if (to)   range[Op.lte] = bound(to, true);
    const hasRange = Object.getOwnPropertySymbols(range).length > 0;
    if (hasRange) where.started_at = range;

    const items = await db.SiengeBackupLog.findAll({
      where,
      order: [['started_at', 'DESC']],
      ...(hasRange ? {} : { limit: Math.min(parseInt(req.query.limit, 10) || 30, 200) }),
    });

    res.json({ items });
  } catch (err) {
    console.error('[backupController.listBackups]', err);
    res.status(500).json({ error: err.message });
  }
}

export async function getBackup(req, res) {
  try {
    const log = await db.SiengeBackupLog.findByPk(req.params.id);
    if (!log) return res.status(404).json({ error: 'Backup não encontrado' });
    res.json(log);
  } catch (err) {
    console.error('[backupController.getBackup]', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * Dispara o pipeline completo (download Sienge → descomprime → pg_restore)
 * em background. Resposta imediata; UI deve fazer polling em GET /backups.
 */
export async function triggerBackup(req, res) {
  const triggeredBy = `manual:${req.user?.id ?? 'unknown'}`;
  // Via runner: se falhar, a retentativa escalonada assume sozinha, igual à
  // carga do cron. Um disparo manual não deveria ter menos garantia que o cron.
  runWithRetries({ triggeredBy, attempt: 1 })
    .then(r => {
      if (r?.skipped) console.log('⏭️  [SiengeBackup manual] outra rodada já estava em andamento.');
      else console.log(`✅ [SiengeBackup manual] log=${r?.logId}`);
    })
    .catch(e => console.error('❌ [SiengeBackup manual] falhou:', e?.message || e));

  res.status(202).json({ ok: true, message: 'Backup iniciado em background' });
}

/**
 * Marca um backup `running` como `failed`. Usado quando o processo morreu
 * fora do nosso controle (deploy do Railway derrubou o container, OOM, etc.)
 * e o log ficou zumbi, bloqueando o trigger de um novo backup.
 *
 * NÃO tenta matar processo nenhum — assume que o processo já morreu. Só
 * libera o estado pra a UI.
 */
export async function cancelBackup(req, res) {
  try {
    const log = await db.SiengeBackupLog.findByPk(req.params.id);
    if (!log) return res.status(404).json({ error: 'Backup não encontrado' });
    if (log.status !== 'running') {
      return res.status(400).json({ error: `Backup não está em execução (status=${log.status})` });
    }

    const finishedAt = new Date();
    const reason = `Cancelado manualmente por ${req.user?.id ?? 'desconhecido'} — processo provavelmente morto (deploy/crash).`;
    await log.update({
      status: 'failed',
      finished_at: finishedAt,
      duration_ms: finishedAt - new Date(log.started_at),
      error_message: reason,
      // Se o restore estava rodando, marca como falho também
      import_status: log.import_status === 'running' ? 'failed' : log.import_status,
      import_finished_at: log.import_status === 'running' ? finishedAt : log.import_finished_at,
      import_error_message: log.import_status === 'running' ? reason : log.import_error_message,
    });
    console.log(`[backupController.cancelBackup] log=${log.id} marcado como failed`);
    res.json({ ok: true, log });
  } catch (err) {
    console.error('[backupController.cancelBackup]', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /sienge/backups/freshness
 *
 * De quando é o dado do espelho. Não é admin-only de propósito: qualquer tela
 * que lê o backup (Custos/Títulos, Recebimentos do Ato, Inadimplência, Stand de
 * Vendas) precisa poder dizer ao usuário a data do que está mostrando.
 */
export async function getFreshness(req, res) {
  try {
    const force = req.query.force === 'true';
    res.json(await getMirrorFreshness({ force }));
  } catch (err) {
    console.error('[backupController.getFreshness]', err);
    res.status(500).json({ error: err.message });
  }
}

/** GET /sienge/backups/settings */
export async function getBackupSettings(req, res) {
  try {
    res.json(await getSettings());
  } catch (err) {
    console.error('[backupController.getBackupSettings]', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * PUT /sienge/backups/settings
 *
 * Recarrega o scheduler na sequência: mudar o horário na tela tem que valer
 * agora, sem esperar deploy.
 */
export async function updateBackupSettings(req, res) {
  try {
    const saved = await updateSettings(req.body || {}, req.user?.id ?? null);
    if (process.env.ENABLE_SIENGE_BACKUP_SCHEDULE === 'true') {
      await siengeBackupScheduler.reload()
        .catch(e => console.warn('[backupController] reload do scheduler falhou:', e.message));
    }
    res.json(saved);
  } catch (err) {
    console.error('[backupController.updateBackupSettings]', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /sienge/backups/watchdog
 * Roda o vigia de frescor na hora. Serve pra conferir a regra na tela sem
 * esperar o cron de 30 minutos.
 */
export async function runWatchdog(req, res) {
  try {
    res.json(await watchdogTick());
  } catch (err) {
    console.error('[backupController.runWatchdog]', err);
    res.status(500).json({ error: err.message });
  }
}

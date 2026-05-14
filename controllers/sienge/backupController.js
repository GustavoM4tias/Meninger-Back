// controllers/sienge/backupController.js
// Endpoints pra a UI do Menin Office consultar status dos backups do Sienge.

import db from '../../models/sequelize/index.js';
import { runDailyBackup } from '../../services/sienge/SiengeBackupService.js';

export async function listBackups(req, res) {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10) || 30, 200);
    const status = req.query.status; // opcional: 'success' | 'failed' | 'running'

    const where = {};
    if (status) where.status = status;

    const items = await db.SiengeBackupLog.findAll({
      where,
      order: [['started_at', 'DESC']],
      limit,
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
  runDailyBackup({ triggeredBy })
    .then(r => console.log(`✅ [SiengeBackup manual] log=${r.logId} size=${r.size}`))
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

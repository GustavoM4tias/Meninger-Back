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

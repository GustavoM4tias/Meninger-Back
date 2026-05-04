// Helpers para ler/gravar estado de jobs de sync no banco.
// Substitui o `state.lastRunAt` em memória que se perdia em restarts.
import db from '../../../models/sequelize/index.js';

const { CvSyncState } = db;

export async function getLastRunAt(jobName) {
    try {
        const row = await CvSyncState.findByPk(jobName);
        return row?.last_run_at || null;
    } catch (e) {
        console.warn(`[syncState] getLastRunAt(${jobName}) falhou:`, e?.message || e);
        return null;
    }
}

export async function markRunning(jobName) {
    try {
        await CvSyncState.upsert({ job_name: jobName, last_status: 'running' });
    } catch (e) {
        console.warn(`[syncState] markRunning(${jobName}) falhou:`, e?.message || e);
    }
}

export async function markFinished(jobName, { status = 'ok', message = null, stats = null } = {}) {
    const now = new Date();
    try {
        await CvSyncState.upsert({
            job_name: jobName,
            last_run_at: now,
            last_status: status,
            last_message: message,
            last_stats: stats,
        });
    } catch (e) {
        console.warn(`[syncState] markFinished(${jobName}) falhou:`, e?.message || e);
    }
    return now;
}

// services/checklist/lib.js
// Helpers compartilhados do módulo Checklist (sem ciclos de import).
import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';

// Carrega o catálogo de status em um Map(id -> { state_class, label, color, ... }).
export async function loadStatusMap() {
    const rows = await db.ChecklistStatus.findAll({
        attributes: ['id', 'label', 'color', 'state_class', 'scope', 'template_id', 'position', 'is_active'],
        raw: true,
    });
    return new Map(rows.map((r) => [r.id, r]));
}

export function stateClassOf(task, statusMap) {
    if (!task || !task.status_id) return 'TODO';
    return statusMap.get(task.status_id)?.state_class || 'TODO';
}

// Agregados a partir das tarefas + catálogo. CANCELLED sai do denominador.
export function computeProgress(tasks, statusMap, { today = dayjs().format('YYYY-MM-DD') } = {}) {
    let total = 0, done = 0, in_progress = 0, blocked = 0, todo = 0, overdue = 0;
    let budget = 0, budget_monthly = 0;
    for (const t of tasks) {
        const sc = stateClassOf(t, statusMap);
        if (sc === 'CANCELLED') continue;
        total++;
        if (sc === 'DONE') done++;
        else if (sc === 'BLOCKED') blocked++;
        else if (sc === 'IN_PROGRESS') in_progress++;
        else todo++;
        if (t.due_date && sc !== 'DONE' && String(t.due_date) < today) overdue++;
        const v = Number(t.value) || 0;
        if (t.value_kind === 'MONTHLY') budget_monthly += v; else budget += v;
    }
    const pct = total ? Math.round((done / total) * 100) : 0;
    return { total, done, in_progress, blocked, todo, overdue, pct, budget, budget_monthly };
}

// Recalcula e persiste o cache de progresso do checklist.
export async function recomputeProgress(checklistId) {
    const [tasks, statusMap] = await Promise.all([
        db.ChecklistTask.findAll({
            where: { checklist_id: checklistId },
            attributes: ['id', 'status_id', 'due_date', 'value', 'value_kind'],
            raw: true,
        }),
        loadStatusMap(),
    ]);
    const progress = computeProgress(tasks, statusMap);
    await db.Checklist.update({ progress_cache: progress }, { where: { id: checklistId } });
    return progress;
}

// Trilha de atividade (best-effort, nunca lança).
export async function logActivity({ checklistId, taskId = null, userId = null, action, meta = null }) {
    try {
        await db.ChecklistActivity.create({ checklist_id: checklistId, task_id: taskId, user_id: userId, action, meta });
    } catch (err) {
        console.warn('[checklist.logActivity] falhou:', err?.message || err);
    }
}

// Extrai @usernames de um texto (para notificar menções em comentários).
export function parseMentions(body = '') {
    const set = new Set();
    const re = /@([a-zA-Z0-9._-]{2,40})/g;
    let m;
    while ((m = re.exec(body)) !== null) set.add(m[1].toLowerCase());
    return Array.from(set);
}

// due_date = data do marco (key_dates) + offset. Null se faltar âncora/marco.
export function computeDueDate({ anchor, offsetDays, keyDates }) {
    if (!anchor || offsetDays === null || offsetDays === undefined) return null;
    const keyMap = { STORE_OPENING: 'store_opening', MEETING: 'meeting', START: 'start' };
    const key = keyMap[anchor] || String(anchor).toLowerCase();
    const kd = Array.isArray(keyDates) ? keyDates.find((k) => k.key === key) : null;
    if (!kd || !kd.date) return null;
    return dayjs(kd.date).add(Number(offsetDays), 'day').format('YYYY-MM-DD');
}

// scheduler/academyDeadlineScheduler.js
//
// Lembretes de trilhas obrigatórias:
//   - D-3: lembrete "faltam 3 dias"
//   - D-1: lembrete "vence amanhã"
//   - D0 : alerta "vence hoje" + flag overdue se passar
//
// Idempotente: usa uma "deadline_notif" Map em memória por dia. Como o
// banco não tem coluna "notified_at" no assignment, marcamos a notif por
// chave (assignmentId+stage+date) num cache simples — se reiniciar processo
// no mesmo dia, pode duplicar. Para idempotência forte, adicionar coluna
// `last_reminder_at` no assignment numa próxima iteração.

import cron from 'node-cron';
import { Op } from 'sequelize';
import dayjs from 'dayjs';
import db from '../models/sequelize/index.js';
import NotificationService from '../services/notification/NotificationService.js';
import { NotificationType } from '../services/notification/notificationTypes.js';

// Cache simples por dia (resetado quando o app reinicia ou muda o dia).
const dispatchedToday = new Set();
let dispatchedDay = dayjs().format('YYYY-MM-DD');

function resetCacheIfNewDay() {
    const today = dayjs().format('YYYY-MM-DD');
    if (today !== dispatchedDay) {
        dispatchedToday.clear();
        dispatchedDay = today;
    }
}

async function resolveAffectedUserIds(assignment) {
    if (assignment.scopeType === 'USER') {
        const uid = Number(assignment.scopeValue);
        return Number.isFinite(uid) && uid > 0 ? [uid] : [];
    }

    const where = { status: true };

    if (assignment.scopeType === 'ROLE') {
        where.role = String(assignment.scopeValue).trim();
    } else if (assignment.scopeType === 'POSITION') {
        const pos = await db.Position.findOne({ where: { code: String(assignment.scopeValue) }, attributes: ['name'], raw: true });
        if (!pos?.name) return [];
        where.position = pos.name;
    } else if (assignment.scopeType === 'DEPARTMENT') {
        const positions = await db.Position.findAll({ where: { department_id: Number(assignment.scopeValue) }, attributes: ['name'], raw: true });
        const names = positions.map(p => p.name).filter(Boolean);
        if (!names.length) return [];
        where.position = { [Op.in]: names };
    } else if (assignment.scopeType === 'CITY') {
        const city = await db.UserCity.findByPk(Number(assignment.scopeValue), { attributes: ['name'], raw: true });
        if (!city?.name) return [];
        where.city = city.name;
    } else {
        return [];
    }

    const users = await db.User.findAll({ where, attributes: ['id'], raw: true });
    return users.map(u => Number(u.id));
}

async function runDeadlineCheck() {
    resetCacheIfNewDay();

    const today = dayjs().startOf('day');
    const horizon = today.add(4, 'day').endOf('day').toDate();

    // Busca todos os assignments mandatórios cujo dueAt está nos próximos 4 dias ou já venceu há até 1 dia.
    const assignments = await db.AcademyTrackAssignment.findAll({
        where: {
            mandatory: true,
            dueAt: { [Op.between]: [today.subtract(1, 'day').toDate(), horizon] },
        },
        raw: true,
    });

    if (!assignments.length) return;

    for (const a of assignments) {
        const due = dayjs(a.dueAt).startOf('day');
        const diffDays = due.diff(today, 'day');

        // Define o estágio do lembrete
        let stage = null;
        if (diffDays === 3) stage = 'D-3';
        else if (diffDays === 1) stage = 'D-1';
        else if (diffDays === 0) stage = 'D0';
        else if (diffDays < 0 && diffDays >= -1) stage = 'OVERDUE';

        if (!stage) continue;

        const key = `${a.id}:${stage}:${dispatchedDay}`;
        if (dispatchedToday.has(key)) continue;

        // eslint-disable-next-line no-await-in-loop
        const userIds = await resolveAffectedUserIds(a);
        if (!userIds.length) {
            dispatchedToday.add(key);
            continue;
        }

        // Filtra users que JÁ concluíram a trilha — eles não recebem lembrete.
        // eslint-disable-next-line no-await-in-loop
        const completedRows = await db.AcademyUserTrackProgress.findAll({
            where: {
                userId: { [Op.in]: userIds },
                trackSlug: a.trackSlug,
                status: 'COMPLETED',
            },
            attributes: ['userId'],
            raw: true,
        });
        const completedSet = new Set(completedRows.map(r => Number(r.userId)));
        const pendingUserIds = userIds.filter(uid => !completedSet.has(uid));

        if (!pendingUserIds.length) {
            dispatchedToday.add(key);
            continue;
        }

        // eslint-disable-next-line no-await-in-loop
        const track = await db.AcademyTrack.findOne({
            where: { slug: a.trackSlug },
            attributes: ['title'],
            raw: true,
        });

        const trackTitle = track?.title || a.trackSlug;
        const dueStr = due.format('DD/MM/YYYY');

        const titles = {
            'D-3': `Trilha "${trackTitle}" vence em 3 dias`,
            'D-1': `Trilha "${trackTitle}" vence amanhã`,
            'D0': `Trilha "${trackTitle}" vence hoje`,
            'OVERDUE': `Trilha "${trackTitle}" está em atraso`,
        };
        const bodies = {
            'D-3': `Você precisa concluir até ${dueStr}.`,
            'D-1': `Restam algumas horas — conclua até ${dueStr}.`,
            'D0': `Hoje (${dueStr}) é o último dia para concluir.`,
            'OVERDUE': `O prazo era ${dueStr}. Conclua o quanto antes.`,
        };
        const importances = { 'D-3': 5, 'D-1': 7, 'D0': 8, 'OVERDUE': 9 };

        try {
            // eslint-disable-next-line no-await-in-loop
            await NotificationService.notify({
                type: NotificationType.ACADEMY_TRACK_ASSIGNED, // reusa o tipo (preferência já existe)
                recipients: { users: pendingUserIds },
                title: titles[stage],
                body: bodies[stage],
                data: { trackSlug: a.trackSlug, stage, dueAt: a.dueAt },
                link: `/academy/tracks/${encodeURIComponent(a.trackSlug)}`,
                importance: importances[stage],
            });
            dispatchedToday.add(key);
            console.log(`[academyDeadline] sent ${stage} for "${trackTitle}" to ${pendingUserIds.length} user(s)`);
        } catch (err) {
            console.warn(`[academyDeadline] notify failed for assignment ${a.id} (${stage})`, err?.message);
        }
    }
}

export function startAcademyDeadlineScheduler() {
    // Roda diariamente às 9h (horário do servidor). Cron pattern: minuto hora * * *
    cron.schedule('0 9 * * *', () => {
        runDeadlineCheck().catch(err => console.error('[academyDeadline]', err));
    });
    console.log('[academyDeadlineScheduler] iniciado (cron: 0 9 * * *)');
}

// Para testar manualmente:
export { runDeadlineCheck };

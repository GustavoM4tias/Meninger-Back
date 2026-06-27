// scheduler/todoDigestScheduler.js
//
// Resumo diário do Microsoft To Do. Para cada usuário com conta Microsoft, lê as
// tarefas ABERTAS com prazo (ao vivo, app-only) e dispara UMA notificação-digest
// com o que está atrasado, vence hoje e vence amanhã. Idempotente por dia
// (não reenvia se já houve um digest hoje). Canais respeitam as preferências do
// usuário (default só in-app).

import cron from 'node-cron';
import { Op } from 'sequelize';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';
import db from '../models/sequelize/index.js';
import todoService from '../services/microsoft/MicrosoftTodoService.js';
import NotificationService from '../services/notification/NotificationService.js';
import { NotificationType } from '../services/notification/notificationTypes.js';

dayjs.extend(utc); dayjs.extend(tz);
const TZ = process.env.TIMEZONE || 'America/Sao_Paulo';

function buildBody({ today, tomorrow, overdue }) {
    const head = [];
    if (overdue.length)  head.push(`⏰ ${overdue.length} atrasada(s)`);
    if (today.length)    head.push(`📌 ${today.length} para hoje`);
    if (tomorrow.length) head.push(`🗓️ ${tomorrow.length} para amanhã`);
    const sample = [...overdue, ...today].slice(0, 4).map((t) => `• ${t.title}`).join('\n');
    return sample ? `${head.join(' · ')}\n${sample}` : head.join(' · ');
}

async function runDigest() {
    const todayStr    = dayjs().tz(TZ).format('YYYY-MM-DD');
    const tomorrowStr = dayjs().tz(TZ).add(1, 'day').format('YYYY-MM-DD');
    const startToday  = dayjs().tz(TZ).startOf('day').toDate();

    const users = await db.User.findAll({
        where: { microsoft_id: { [Op.ne]: null }, status: true },
        attributes: ['id', 'microsoft_id', 'username'],
    });

    let dispatched = 0;
    for (const u of users) {
        try {
            const tasks = await todoService.aggregateOpenWithDue(u.microsoft_id);
            if (!tasks.length) continue;

            const overdue  = tasks.filter((t) => t.dueStr < todayStr);
            const today    = tasks.filter((t) => t.dueStr === todayStr);
            const tomorrow = tasks.filter((t) => t.dueStr === tomorrowStr);
            if (!overdue.length && !today.length && !tomorrow.length) continue;

            // Idempotência: no máximo 1 digest por dia por usuário.
            const already = await db.Notification.findOne({
                where: { user_id: u.id, type: NotificationType.TODO_DAILY_DIGEST, created_at: { [Op.gte]: startToday } },
                attributes: ['id'],
            });
            if (already) continue;

            const bits = [];
            if (overdue.length) bits.push(`${overdue.length} atrasada(s)`);
            if (today.length)   bits.push(`${today.length} para hoje`);
            if (!bits.length && tomorrow.length) bits.push(`${tomorrow.length} para amanhã`);
            const title = `To Do: ${bits.join(', ')}`;
            const body  = buildBody({ today, tomorrow, overdue });

            await NotificationService.notify({
                type: NotificationType.TODO_DAILY_DIGEST,
                recipients: { users: [u.id] },
                title,
                body,
                data: { overdue: overdue.length, today: today.length, tomorrow: tomorrow.length },
                link: '/microsoft/todo',
                importance: 7,
                emailData: { title, body },
            });
            dispatched++;
        } catch (err) {
            console.warn(`[todoDigest] falha p/ user ${u.id}:`, err?.message || err);
        }
    }
    if (dispatched) console.log(`[todoDigest] ${dispatched} resumo(s) de To Do disparado(s).`);
    return dispatched;
}

const todoDigestScheduler = {
    start() {
        const expr = process.env.TODO_DIGEST_CRON || '0 7 * * *'; // 07:00 (TZ do servidor)
        cron.schedule(expr, runDigest, { timezone: TZ });
        console.log(`✅ todoDigestScheduler iniciado (cron: ${expr}, TZ ${TZ}).`);
    },
    runNow: runDigest,
};

export default todoDigestScheduler;

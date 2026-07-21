// scheduler/eventReminderScheduler.js
// Cria notificações "event.reminder" 1 dia antes do evento.
// Usa o mesmo notify_to do evento e respeita as preferências dos destinatários.
//
// Idempotente: marca cada evento já lembrado em `reminded_at` para não
// duplicar. (Antes marcava com a tag interna '__reminded__' dentro de `tags`,
// que vazava na tela e nas respostas da Eme — ensureEventsSchema migra e
// limpa o legado no boot.)

import cron from 'node-cron';
import { Op } from 'sequelize';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';
import db from '../models/sequelize/index.js';
import NotificationService from '../services/notification/NotificationService.js';
import { NotificationType } from '../services/notification/notificationTypes.js';
import { ensureEventsSchema } from '../lib/ensureEventsSchema.js';

dayjs.extend(utc); dayjs.extend(tz);

const TZ = process.env.TIMEZONE || 'America/Sao_Paulo';
const fmt = (iso) => dayjs.utc(iso).tz(TZ).format('dddd, D [de] MMMM [de] YYYY • HH:mm');

const { Event } = db;

async function runReminders() {
    const now = dayjs().tz(TZ);
    const start = now.add(1, 'day').startOf('day').toDate();
    const end   = now.add(1, 'day').endOf('day').toDate();

    const events = await Event.findAll({
        where: { event_date: { [Op.between]: [start, end] } },
    });

    if (!events.length) return;

    let dispatched = 0;
    for (const ev of events) {
        // Cinto extra: a tag legada ainda conta como "já lembrado" caso o
        // patch do boot ainda não tenha rodado.
        const tags = Array.isArray(ev.tags) ? ev.tags : [];
        if (ev.reminded_at || tags.includes('__reminded__')) continue;

        const notify_to = ev.notify_to || { users: [], positions: [], emails: [] };

        try {
            await NotificationService.notify({
                type: NotificationType.EVENT_REMINDER,
                recipients: notify_to,
                title: `Lembrete: ${ev.title}`,
                body: `Acontece em ${fmt(ev.event_date)}.`,
                data: {
                    eventId: ev.id,
                    image: Array.isArray(ev.images) ? ev.images[0] : null,
                    eventDateISO: ev.event_date,
                    eventDateFormatted: fmt(ev.event_date),
                },
                link: `/marketing/Events?search=${encodeURIComponent(ev.title)}`,
                importance: 8,
                emailData: {
                    title: ev.title,
                    description: ev.description,
                    eventDateISO: ev.event_date,
                    eventDateFormatted: fmt(ev.event_date),
                    images: ev.images || [],
                    address: ev.address || {},
                    organizers: ev.organizers || [],
                },
            });
            dispatched++;

            // marca o evento como já lembrado (coluna própria, fora de tags)
            await ev.update({ reminded_at: new Date() });
        } catch (err) {
            console.error(`[eventReminder] falha no evento ${ev.id}:`, err?.message || err);
        }
    }

    if (dispatched) console.log(`[eventReminder] ${dispatched} lembrete(s) disparado(s).`);
}

const eventReminderScheduler = {
    start() {
        // Patch idempotente no boot: cria reminded_at + migra/limpa a tag
        // legada '__reminded__' de todos os eventos (uma vez; depois no-op).
        ensureEventsSchema().catch(e =>
            console.warn('⚠️  ensureEventsSchema (boot):', e?.message || e));
        // Todo dia às 09:00 (TZ do servidor)
        cron.schedule('0 9 * * *', runReminders, { timezone: TZ });
        console.log('✅ eventReminderScheduler iniciado (diário às 09:00).');
    },
    runNow: runReminders,
};

export default eventReminderScheduler;

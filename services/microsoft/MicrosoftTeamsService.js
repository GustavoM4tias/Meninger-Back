// services/microsoft/MicrosoftTeamsService.js
import graph from './MicrosoftGraphService.js';

const EVENT_SELECT = [
    'id', 'subject', 'bodyPreview', 'body', 'start', 'end',
    'isAllDay', 'isOnlineMeeting', 'onlineMeeting',
    'location', 'organizer', 'attendees',
    'webLink', 'showAs', 'sensitivity',
    'responseStatus', 'isCancelled', 'importance', 'recurrence',
].join(',');

function normalizeEvent(e) {
    return {
        id: e.id,
        subject: e.subject || '(Sem título)',
        bodyPreview: e.bodyPreview || '',
        body: e.body?.content || '',
        bodyType: e.body?.contentType || 'text',
        start: e.start?.dateTime || null,        // ISO datetime in event's timezone
        end: e.end?.dateTime || null,
        startTz: e.start?.timeZone || 'UTC',
        endTz: e.end?.timeZone || 'UTC',
        isAllDay: e.isAllDay || false,
        isOnlineMeeting: e.isOnlineMeeting || false,
        joinUrl: e.onlineMeeting?.joinUrl || null,
        location: e.location?.displayName || null,
        organizer: {
            name: e.organizer?.emailAddress?.name || null,
            email: e.organizer?.emailAddress?.address || null,
        },
        attendees: (e.attendees || []).map(a => ({
            name: a.emailAddress?.name || a.emailAddress?.address || '',
            email: a.emailAddress?.address || '',
            status: a.status?.response || 'none',   // none | accepted | declined | tentativelyAccepted
            type: a.type || 'required',              // required | optional | resource
        })),
        webLink: e.webLink || null,
        showAs: e.showAs || 'busy',
        responseStatus: e.responseStatus?.response || 'none',
        isCancelled: e.isCancelled || false,
        importance: e.importance || 'normal',
        isRecurring: !!e.recurrence,
    };
}

class MicrosoftTeamsService {

    // ── Calendário ────────────────────────────────────────────────────────────

    /**
     * Busca todos os eventos do usuário em um intervalo de datas.
     * @param {object} user
     * @param {string} startDateTime - ISO 8601 (UTC)
     * @param {string} endDateTime   - ISO 8601 (UTC)
     */
    async getCalendarView(user, startDateTime, endDateTime) {
        const params = {
            startDateTime,
            endDateTime,
            $select: EVENT_SELECT,
            $orderby: 'start/dateTime',
            $top: '200',
        };
        // Prefer header converte todos os horários para o fuso de Brasília automaticamente
        const data = await graph.get(
            user,
            '/me/calendarView',
            params,
            { 'Prefer': 'outlook.timezone="America/Sao_Paulo"' }
        );
        return (data.value || []).map(normalizeEvent);
    }

    async getEvent(user, eventId) {
        const data = await graph.get(user, `/me/events/${eventId}?$select=${EVENT_SELECT}`);
        return normalizeEvent(data);
    }

    // ── Criar reunião agendada (cria evento no Outlook + link Teams) ──────────

    /**
     * @param {object} user
     * @param {{ subject, start, end, attendees, body, isOnlineMeeting, location, isAllDay, recurrence }} opts
     *   start/end: ISO datetime strings (sem Z) no fuso America/Sao_Paulo
     *   recurrence: { type: 'daily'|'weekly'|'monthly', interval, endType: 'noEnd'|'endDate'|'count', endDate, occurrences }
     */
    async createScheduledMeeting(user, { subject, start, end, attendees = [], body = '', isOnlineMeeting = true, location = '', isAllDay = false, recurrence = null }) {
        const payload = {
            subject,
            body: { contentType: 'html', content: body || '' },
            start: { dateTime: start, timeZone: 'America/Sao_Paulo' },
            end:   { dateTime: end,   timeZone: 'America/Sao_Paulo' },
            isAllDay,
            isOnlineMeeting,
            onlineMeetingProvider: isOnlineMeeting ? 'teamsForBusiness' : 'unknown',
            attendees: attendees
                .filter(Boolean)
                .map(email => ({ emailAddress: { address: email.trim() }, type: 'required' })),
        };

        if (location) payload.location = { displayName: location };

        if (recurrence) payload.recurrence = this._buildRecurrence(recurrence, start);

        const data = await graph.post(user, '/me/events', payload);
        return normalizeEvent(data);
    }

    _buildRecurrence({ type, interval = 1, endType = 'noEnd', endDate, occurrences }, startDateStr) {
        const startDate = startDateStr.split('T')[0];
        const startDay  = new Date(startDateStr);

        const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

        const pattern = { interval };
        if (type === 'daily')   { pattern.type = 'daily'; }
        if (type === 'weekly')  { pattern.type = 'weekly'; pattern.daysOfWeek = [DAY_NAMES[startDay.getDay()]]; }
        if (type === 'monthly') { pattern.type = 'absoluteMonthly'; pattern.dayOfMonth = startDay.getDate(); }

        const range = { startDate };
        if (endType === 'noEnd')   { range.type = 'noEnd'; }
        if (endType === 'endDate') { range.type = 'endDate'; range.endDate = endDate; }
        if (endType === 'count')   { range.type = 'numbered'; range.numberOfOccurrences = Number(occurrences) || 10; }

        return { pattern, range };
    }

    /** Atualiza um evento existente (patch) */
    async updateEvent(user, eventId, { subject, start, end, attendees, body, isOnlineMeeting, location, isAllDay, recurrence }) {
        const payload = {};
        if (subject !== undefined) payload.subject = subject;
        if (body !== undefined)    payload.body = { contentType: 'html', content: body || '' };
        if (start !== undefined)   payload.start = { dateTime: start, timeZone: 'America/Sao_Paulo' };
        if (end !== undefined)     payload.end   = { dateTime: end,   timeZone: 'America/Sao_Paulo' };
        if (isAllDay !== undefined) payload.isAllDay = isAllDay;
        if (location !== undefined) payload.location = { displayName: location };
        if (attendees !== undefined) {
            payload.attendees = (attendees || [])
                .filter(Boolean)
                .map(email => ({ emailAddress: { address: email.trim() }, type: 'required' }));
        }
        if (recurrence !== undefined) {
            payload.recurrence = recurrence ? this._buildRecurrence(recurrence, start) : null;
        }
        const data = await graph.patch(user, `/me/events/${eventId}`, payload);
        return normalizeEvent(data);
    }

    // ── Reunião instantânea (online meeting, sem evento no calendário) ────────

    async createInstantMeeting(user, { subject }) {
        const now = new Date();
        const end = new Date(now.getTime() + 60 * 60 * 1000); // 1h

        const data = await graph.post(user, '/me/onlineMeetings', {
            startDateTime: now.toISOString(),
            endDateTime:   end.toISOString(),
            subject: subject || 'Reunião instantânea',
        });

        return {
            id:           data.id,
            subject:      data.subject,
            joinUrl:      data.joinWebUrl,
            startDateTime: data.startDateTime,
            endDateTime:   data.endDateTime,
        };
    }

    // ── Cancelar / excluir evento ─────────────────────────────────────────────

    /** Envia notificação de cancelamento para os participantes e remove o evento. */
    async cancelEvent(user, eventId, comment = '') {
        await graph.post(user, `/me/events/${eventId}/cancel`, { comment });
    }

    /** Remove o evento sem enviar notificação (para eventos que só o organizador vê). */
    async deleteEvent(user, eventId) {
        await graph.delete(user, `/me/events/${eventId}`);
    }
}

export default new MicrosoftTeamsService();

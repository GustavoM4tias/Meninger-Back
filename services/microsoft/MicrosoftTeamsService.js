// services/microsoft/MicrosoftTeamsService.js
import graph from './MicrosoftGraphService.js';
import settingsService from './MicrosoftSettingsService.js';

const EVENT_SELECT = [
    'id', 'subject', 'bodyPreview', 'body', 'start', 'end',
    'isAllDay', 'isOnlineMeeting', 'onlineMeeting',
    'location', 'organizer', 'attendees',
    'webLink', 'showAs', 'sensitivity',
    'responseStatus', 'isCancelled', 'importance', 'recurrence',
    'type', 'seriesMasterId', 'isOrganizer',
].join(',');

// O Graph devolve horário no fuso do evento; sem este cabeçalho a resposta vem
// em UTC e a mesma reunião aparece três horas fora do lugar. A listagem já usava
// isto — leitura avulsa e edição passaram a usar também.
const TZ_PREFER = { Prefer: 'outlook.timezone="America/Sao_Paulo"' };

/**
 * O campo de descrição da tela é texto puro, mas o corpo do evento é HTML:
 * mandar o texto cru colapsa as quebras de linha do convite. Texto vira HTML de
 * verdade; se já vier com marcação, passa direto.
 */
function toHtml(texto) {
    const s = String(texto ?? '');
    if (!s.trim()) return '';
    if (/<[a-z][\s\S]*>/i.test(s)) return s;
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\r?\n/g, '<br>');
}

/**
 * Recorta o bloco "Ingressar na reunião do Microsoft Teams" que a Microsoft
 * escreve DENTRO do corpo do convite.
 *
 * Um PATCH de `body` substitui o corpo inteiro e o Graph NÃO regenera esse
 * bloco: quem editava a descrição de uma reunião perdia o link de entrada no
 * convite que já estava na caixa de todo mundo. Aqui o bloco é separado para ser
 * recolado depois do texto novo.
 */
function extractTeamsBlock(html) {
    if (!html) return '';
    const hit = String(html).search(/class="[^"]*me-email-text|_{20,}|<div[^>]*id="meeting-join/i);
    if (hit < 0) return '';
    const abre = String(html).lastIndexOf('<div', hit);
    return String(html).slice(abre >= 0 ? abre : hit);
}

// Converte o objeto recurrence do Graph para o shape simplificado usado pela UI
// ({ type, interval, endType, endDate, occurrences }). Padrões fora do subset
// suportado (relativeMonthly, yearly, múltiplos dias da semana) retornam
// { unsupported: true } — a UI exibe read-only e nunca envia PATCH de recorrência.
function simplifyRecurrence(rec) {
    if (!rec?.pattern || !rec?.range) return null;

    const { pattern, range } = rec;
    const out = { interval: pattern.interval || 1 };

    if (pattern.type === 'daily') {
        out.type = 'daily';
    } else if (pattern.type === 'weekly' && (pattern.daysOfWeek || []).length === 1) {
        out.type = 'weekly';
    } else if (pattern.type === 'absoluteMonthly') {
        out.type = 'monthly';
    } else {
        return { unsupported: true };
    }

    if (range.type === 'noEnd') {
        out.endType = 'noEnd';
    } else if (range.type === 'endDate') {
        out.endType = 'endDate';
        out.endDate = range.endDate || null;
    } else if (range.type === 'numbered') {
        out.endType = 'count';
        out.occurrences = range.numberOfOccurrences || 1;
    } else {
        return { unsupported: true };
    }

    return out;
}

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
        // calendarView devolve ocorrências expandidas (type: 'occurrence') sem o
        // objeto recurrence — este só existe no seriesMaster. Por isso o flag
        // deriva do type, não da presença de recurrence.
        type: e.type || 'singleInstance',            // singleInstance | occurrence | exception | seriesMaster
        seriesMasterId: e.seriesMasterId || null,
        isOrganizer: e.isOrganizer === true,
        isRecurring: e.type === 'occurrence' || e.type === 'exception' || e.type === 'seriesMaster' || !!e.recurrence,
        recurrence: e.recurrence ? simplifyRecurrence(e.recurrence) : null,
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
        // Prefer header converte todos os horários para o fuso de Brasília automaticamente.
        // getAllPages segue o @odata.nextLink: mês cheio de agenda não some do fim
        // da lista só porque não coube numa página.
        const cap = await settingsService.listCap();
        const { items, truncated } = await graph.getAllPages(
            user,
            '/me/calendarView',
            params,
            { max: cap, headers: { 'Prefer': 'outlook.timezone="America/Sao_Paulo"' } }
        );
        return { items: items.map(normalizeEvent), truncated };
    }

    /**
     * Disponibilidade de um grupo de pessoas num intervalo (getSchedule).
     *
     * Antes disto o modal de reunião pedia horário no escuro e a pessoa
     * descobria o conflito remarcando. O Graph devolve os blocos ocupados de
     * cada agenda sem expor o assunto do compromisso alheio — só que está
     * ocupado, que é exatamente o que basta para escolher um horário.
     *
     * @param {string[]} emails
     * @param {string} start ISO local sem Z (America/Sao_Paulo)
     * @param {string} end
     * @param {number} slotMinutes granularidade do retorno
     */
    async getSchedule(user, emails, start, end, slotMinutes = 30) {
        const data = await graph.post(user, '/me/calendar/getSchedule', {
            schedules: emails,
            startTime: { dateTime: start, timeZone: 'America/Sao_Paulo' },
            endTime:   { dateTime: end,   timeZone: 'America/Sao_Paulo' },
            availabilityViewInterval: slotMinutes,
        });

        return (data.value || []).map(s => {
            const ocupado = (s.scheduleItems || [])
                // 'free' e 'workingElsewhere' não impedem reunião.
                .filter(i => !['free', 'workingElsewhere'].includes(i.status))
                .map(i => ({
                    inicio: i.start?.dateTime || null,
                    fim: i.end?.dateTime || null,
                    situacao: i.status,   // busy | tentative | oof
                }));

            return {
                email: s.scheduleId,
                // availabilityView é uma string de dígitos, um por slot:
                // 0 livre, 1 tentativo, 2 ocupado, 3 fora do escritório.
                mapa: s.availabilityView || '',
                ocupado,
                livre: ocupado.length === 0,
                erro: s.error?.message || null,
            };
        });
    }

    async getEvent(user, eventId) {
        const data = await graph.get(user, `/me/events/${eventId}?$select=${EVENT_SELECT}`, undefined, TZ_PREFER);
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
            body: { contentType: 'html', content: toHtml(body) },
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

        // recurrenceTimeZone evita off-by-one na última ocorrência (Graph usa UTC por padrão no range)
        const range = { startDate, recurrenceTimeZone: 'America/Sao_Paulo' };
        if (endType === 'noEnd')   { range.type = 'noEnd'; }
        if (endType === 'endDate') { range.type = 'endDate'; range.endDate = endDate; }
        if (endType === 'count')   { range.type = 'numbered'; range.numberOfOccurrences = Number(occurrences) || 10; }

        return { pattern, range };
    }

    /**
     * Atualiza um evento existente (patch).
     *
     * Editar uma reunião do Teams NÃO pode rebaixá-la a evento simples. Três
     * coisas garantem isso aqui:
     *   1. O corpo novo é colado antes do bloco de entrada do Teams, que o Graph
     *      não regenera depois de um PATCH de `body`.
     *   2. `isOnlineMeeting` só vai quando o evento AINDA NÃO é reunião — pedir
     *      de novo o que já existe faz o Graph recusar a edição inteira.
     *   3. A resposta do PATCH vem sem `$select` e sem o Prefer de fuso, ou
     *      seja, sem `onlineMeeting` (o joinUrl) e com horário em UTC. Por isso
     *      o retorno é uma releitura, com o mesmo contrato da listagem: era daí
     *      que vinha a reunião virar "evento", sem copiar link nem participante.
     */
    async updateEvent(user, eventId, { subject, start, end, attendees, body, isOnlineMeeting, location, isAllDay, recurrence }) {
        const atual = await graph.get(user, `/me/events/${eventId}?$select=${EVENT_SELECT}`, undefined, TZ_PREFER);

        const payload = {};
        if (subject !== undefined) payload.subject = subject;
        if (body !== undefined) {
            const bloco = extractTeamsBlock(atual?.body?.content);
            payload.body = { contentType: 'html', content: toHtml(body) + bloco };
        }
        // Evento simples pode virar reunião do Teams. O caminho inverso o Graph
        // não desfaz (o convite já saiu com link), então o pedido é ignorado —
        // e a tela nem oferece a troca na edição.
        if (isOnlineMeeting === true && atual?.isOnlineMeeting !== true) {
            payload.isOnlineMeeting = true;
            payload.onlineMeetingProvider = 'teamsForBusiness';
        }
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
        await graph.patch(user, `/me/events/${eventId}`, payload);
        return this.getEvent(user, eventId);
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

    /** Resolve o id do seriesMaster de um evento recorrente. */
    async _resolveSeriesMasterId(user, eventId, seriesMasterId) {
        if (seriesMasterId) return seriesMasterId;
        const event = await this.getEvent(user, eventId);
        return event.seriesMasterId || eventId;
    }

    /**
     * Cancela o evento como ORGANIZADOR (Graph envia notificação aos participantes).
     * @param {string} scope
     *   - 'single':     evento não recorrente — cancel direto no id.
     *   - 'occurrence': só esta ocorrência da série — o Graph NÃO aceita /cancel em
     *                   ocorrência, então usamos DELETE (o Graph vira uma exceção de
     *                   ocorrência excluída e avisa os participantes; sem comentário).
     *   - 'series':     toda a série — cancel no seriesMaster.
     */
    async cancelEvent(user, eventId, { comment = '', scope = 'single', seriesMasterId = null } = {}) {
        if (scope === 'series') {
            const masterId = await this._resolveSeriesMasterId(user, eventId, seriesMasterId);
            await graph.post(user, `/me/events/${masterId}/cancel`, { comment });
            return;
        }
        if (scope === 'occurrence') {
            await graph.delete(user, `/me/events/${eventId}`);
            return;
        }
        await graph.post(user, `/me/events/${eventId}/cancel`, { comment });
    }

    /**
     * Remove o evento do calendário do PRÓPRIO usuário, sem notificar ninguém
     * (caminho do participante; ou eventos que só o organizador vê).
     * scope 'series' remove a série inteira via seriesMaster.
     */
    async deleteEvent(user, eventId, { scope = 'occurrence', seriesMasterId = null } = {}) {
        if (scope === 'series') {
            const masterId = await this._resolveSeriesMasterId(user, eventId, seriesMasterId);
            await graph.delete(user, `/me/events/${masterId}`);
            return;
        }
        await graph.delete(user, `/me/events/${eventId}`);
    }
}

export default new MicrosoftTeamsService();

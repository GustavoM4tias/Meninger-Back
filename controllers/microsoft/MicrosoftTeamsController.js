// controllers/microsoft/MicrosoftTeamsController.js
import teamsService from '../../services/microsoft/MicrosoftTeamsService.js';

function handleErr(res, err, ctx) {
    const msg = err?.message || '';
    console.error(`❌ [Teams] ${ctx}:`, err?.response?.data || msg);
    const isAuth = msg.toLowerCase().includes('não conectada') || msg.toLowerCase().includes('expirada');
    return res.status(isAuth ? 401 : err?.response?.status || 500).json({ error: msg });
}

class MicrosoftTeamsController {

    async calendarView(req, res) {
        if (!req.user.microsoft_id) return res.status(401).json({ error: 'Conta Microsoft não conectada.' });
        try {
            const { start, end } = req.query;
            if (!start || !end) return res.status(400).json({ error: 'Parâmetros start e end são obrigatórios.' });
            res.json(await teamsService.getCalendarView(req.user, start, end));
        } catch (err) { handleErr(res, err, 'calendarView'); }
    }

    async event(req, res) {
        if (!req.user.microsoft_id) return res.status(401).json({ error: 'Conta Microsoft não conectada.' });
        try {
            res.json(await teamsService.getEvent(req.user, req.params.eventId));
        } catch (err) { handleErr(res, err, 'event'); }
    }

    async createScheduledMeeting(req, res) {
        if (!req.user.microsoft_id) return res.status(401).json({ error: 'Conta Microsoft não conectada.' });
        try {
            res.status(201).json(await teamsService.createScheduledMeeting(req.user, req.body));
        } catch (err) { handleErr(res, err, 'createScheduledMeeting'); }
    }

    async createInstantMeeting(req, res) {
        if (!req.user.microsoft_id) return res.status(401).json({ error: 'Conta Microsoft não conectada.' });
        try {
            res.status(201).json(await teamsService.createInstantMeeting(req.user, req.body));
        } catch (err) { handleErr(res, err, 'createInstantMeeting'); }
    }

    async updateEvent(req, res) {
        if (!req.user.microsoft_id) return res.status(401).json({ error: 'Conta Microsoft não conectada.' });
        try {
            res.json(await teamsService.updateEvent(req.user, req.params.eventId, req.body));
        } catch (err) { handleErr(res, err, 'updateEvent'); }
    }

    async cancelEvent(req, res) {
        if (!req.user.microsoft_id) return res.status(401).json({ error: 'Conta Microsoft não conectada.' });
        try {
            await teamsService.cancelEvent(req.user, req.params.eventId, req.body?.comment || '');
            res.status(204).end();
        } catch (err) { handleErr(res, err, 'cancelEvent'); }
    }

    async deleteEvent(req, res) {
        if (!req.user.microsoft_id) return res.status(401).json({ error: 'Conta Microsoft não conectada.' });
        try {
            await teamsService.deleteEvent(req.user, req.params.eventId);
            res.status(204).end();
        } catch (err) { handleErr(res, err, 'deleteEvent'); }
    }
}

export default new MicrosoftTeamsController();

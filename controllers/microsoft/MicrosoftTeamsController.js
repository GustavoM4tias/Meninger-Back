// controllers/microsoft/MicrosoftTeamsController.js
import teamsService from '../../services/microsoft/MicrosoftTeamsService.js';

class MicrosoftTeamsController {

    async calendarView(req, res) {
        if (!req.user.microsoft_id) return res.status(401).json({ error: 'Conta Microsoft não conectada.' });
        try {
            const { start, end } = req.query;
            if (!start || !end) return res.status(400).json({ error: 'Parâmetros start e end são obrigatórios.' });
            const events = await teamsService.getCalendarView(req.user, start, end);
            res.json(events);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    async event(req, res) {
        if (!req.user.microsoft_id) return res.status(401).json({ error: 'Conta Microsoft não conectada.' });
        try {
            const event = await teamsService.getEvent(req.user, req.params.eventId);
            res.json(event);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    async createScheduledMeeting(req, res) {
        if (!req.user.microsoft_id) return res.status(401).json({ error: 'Conta Microsoft não conectada.' });
        try {
            const event = await teamsService.createScheduledMeeting(req.user, req.body);
            res.status(201).json(event);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    async createInstantMeeting(req, res) {
        if (!req.user.microsoft_id) return res.status(401).json({ error: 'Conta Microsoft não conectada.' });
        try {
            const meeting = await teamsService.createInstantMeeting(req.user, req.body);
            res.status(201).json(meeting);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    async updateEvent(req, res) {
        if (!req.user.microsoft_id) return res.status(401).json({ error: 'Conta Microsoft não conectada.' });
        try {
            const event = await teamsService.updateEvent(req.user, req.params.eventId, req.body);
            res.json(event);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    async cancelEvent(req, res) {
        if (!req.user.microsoft_id) return res.status(401).json({ error: 'Conta Microsoft não conectada.' });
        try {
            await teamsService.cancelEvent(req.user, req.params.eventId, req.body?.comment || '');
            res.status(204).end();
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    async deleteEvent(req, res) {
        if (!req.user.microsoft_id) return res.status(401).json({ error: 'Conta Microsoft não conectada.' });
        try {
            await teamsService.deleteEvent(req.user, req.params.eventId);
            res.status(204).end();
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
}

export default new MicrosoftTeamsController();

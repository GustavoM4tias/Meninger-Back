// controllers/microsoft/MicrosoftTeamsController.js
import teamsService from '../../services/microsoft/MicrosoftTeamsService.js';
import db from '../../models/sequelize/index.js';

function handleErr(res, err, ctx) {
    // Prioriza a mensagem real do Graph (err.response.data.error.message) —
    // sem ela o front só via "Request failed with status code 4xx".
    const graphMsg = err?.response?.data?.error?.message;
    const msg = graphMsg || err?.message || 'Erro inesperado na integração Microsoft.';
    console.error(`❌ [Teams] ${ctx}:`, err?.response?.data || msg);
    const authProbe = (err?.message || '').toLowerCase();
    const isAuth = authProbe.includes('não conectada') || authProbe.includes('expirada');
    return res.status(isAuth ? 401 : err?.response?.status || 500).json({ error: msg });
}

class MicrosoftTeamsController {

    async calendarView(req, res) {
        if (!req.user.microsoft_id) return res.status(401).json({ error: 'Conta Microsoft não conectada.' });
        try {
            const { start, end } = req.query;
            if (!start || !end) return res.status(400).json({ error: 'Parâmetros start e end são obrigatórios.' });
            // Corpo segue sendo o array de eventos; o corte (se houver) vai no cabeçalho.
            const { items, truncated } = await teamsService.getCalendarView(req.user, start, end);
            res.set('X-Graph-Truncated', truncated ? '1' : '0');
            res.set('X-Graph-Count', String(items.length));
            res.set('Access-Control-Expose-Headers', 'X-Graph-Truncated, X-Graph-Count');
            res.json(items);
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
            const meeting = await teamsService.createInstantMeeting(req.user, req.body);

            // Reuniões instantâneas não geram evento de calendário, então não
            // apareceriam na listagem de Transcrições & IA. Persistimos aqui para
            // que o usuário consiga voltar depois e gerar o relatório.
            if (meeting?.id) {
                await db.InstantMeeting.findOrCreate({
                    where: { user_id: req.user.id, meeting_id: meeting.id },
                    defaults: {
                        user_id:         req.user.id,
                        meeting_id:      meeting.id,
                        subject:         meeting.subject || null,
                        join_url:        meeting.joinUrl || null,
                        start_at:        meeting.startDateTime ? new Date(meeting.startDateTime) : new Date(),
                        end_at:          meeting.endDateTime ? new Date(meeting.endDateTime) : null,
                        organizer_name:  req.user.name || null,
                        organizer_email: req.user.email || null,
                    },
                }).catch(err => console.error('⚠️ [Teams] falha ao persistir reunião instantânea:', err.message));
            }

            res.status(201).json(meeting);
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
            const { comment = '', scope = 'single', seriesMasterId = null } = req.body || {};
            await teamsService.cancelEvent(req.user, req.params.eventId, { comment, scope, seriesMasterId });
            res.status(204).end();
        } catch (err) { handleErr(res, err, 'cancelEvent'); }
    }

    async deleteEvent(req, res) {
        if (!req.user.microsoft_id) return res.status(401).json({ error: 'Conta Microsoft não conectada.' });
        try {
            const { scope = 'occurrence', seriesMasterId = null } = req.query || {};
            await teamsService.deleteEvent(req.user, req.params.eventId, { scope, seriesMasterId });
            res.status(204).end();
        } catch (err) { handleErr(res, err, 'deleteEvent'); }
    }
}

export default new MicrosoftTeamsController();

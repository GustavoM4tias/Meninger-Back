// controllers/InPersonMeetingController.js
import { MeetingSummaryService } from '../validatorAI/src/services/MeetingSummaryService.js';
import { cuesToText } from '../services/microsoft/MicrosoftTranscriptService.js';
import { sendEmail } from '../email/email.service.js';
import db from '../models/sequelize/index.js';

function guard(req, res) {
    if (!req.user?.id) {
        res.status(401).json({ error: 'Não autenticado.' });
        return false;
    }
    return true;
}

function durationMin(start, end) {
    if (!start || !end) return null;
    return Math.round((new Date(end) - new Date(start)) / 60000);
}

class InPersonMeetingController {

    // ── GET /inperson/meetings ────────────────────────────────────────────────
    async list(req, res) {
        if (!guard(req, res)) return;
        try {
            const meetings = await db.InPersonMeeting.findAll({
                where: { user_id: req.user.id },
                attributes: { exclude: ['parsed_transcript', 'report_json'] },
                order: [['meeting_date', 'DESC']],
            });
            res.json(meetings);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    // ── GET /inperson/meetings/:id ────────────────────────────────────────────
    async get(req, res) {
        if (!guard(req, res)) return;
        try {
            const record = await db.InPersonMeeting.findOne({
                where: { id: req.params.id, user_id: req.user.id },
            });
            if (!record) return res.status(404).json({ error: 'Reunião não encontrada.' });
            res.json({
                ...record.toJSON(),
                cues: record.parsed_transcript ? JSON.parse(record.parsed_transcript) : [],
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    // ── POST /inperson/meetings ───────────────────────────────────────────────
    async create(req, res) {
        if (!guard(req, res)) return;
        try {
            const { title, location, attendees, organizerName } = req.body;
            if (!title) return res.status(400).json({ error: 'Título obrigatório.' });

            const record = await db.InPersonMeeting.create({
                user_id:        req.user.id,
                title,
                location:       location || null,
                meeting_date:   new Date(),
                organizer_name: organizerName || req.user.name || null,
                attendees_json: attendees || [],
                status:         'recording',
            });

            res.json(record);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    // ── PUT /inperson/meetings/:id ────────────────────────────────────────────
    async update(req, res) {
        if (!guard(req, res)) return;
        try {
            const record = await db.InPersonMeeting.findOne({
                where: { id: req.params.id, user_id: req.user.id },
            });
            if (!record) return res.status(404).json({ error: 'Reunião não encontrada.' });

            const { cues, title, location, attendees, endedAt } = req.body;
            const parsedJson  = cues ? JSON.stringify(cues) : null;
            const endedDate   = endedAt ? new Date(endedAt) : (cues ? new Date() : null);

            await record.update({
                title:                 title     !== undefined ? title     : record.title,
                location:              location  !== undefined ? location  : record.location,
                attendees_json:        attendees !== undefined ? attendees : record.attendees_json,
                ended_at:              endedDate || record.ended_at,
                duration_min:          endedDate ? durationMin(record.meeting_date, endedDate) : record.duration_min,
                parsed_transcript:     parsedJson || record.parsed_transcript,
                transcript_char_count: parsedJson ? parsedJson.length : record.transcript_char_count,
                status:                cues ? 'recorded' : record.status,
            });

            res.json(record);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    // ── DELETE /inperson/meetings/:id ─────────────────────────────────────────
    async remove(req, res) {
        if (!guard(req, res)) return;
        try {
            const record = await db.InPersonMeeting.findOne({
                where: { id: req.params.id, user_id: req.user.id },
            });
            if (!record) return res.status(404).json({ error: 'Reunião não encontrada.' });
            await record.destroy();
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    // ── POST /inperson/meetings/:id/report ────────────────────────────────────
    async generateReport(req, res) {
        if (!guard(req, res)) return;
        try {
            const { force = false } = req.body;
            const record = await db.InPersonMeeting.findOne({
                where: { id: req.params.id, user_id: req.user.id },
            });
            if (!record)                    return res.status(404).json({ error: 'Reunião não encontrada.' });
            if (!record.parsed_transcript)  return res.status(400).json({ error: 'Sem transcrição para processar.' });
            if (record.status === 'summarized' && record.report_json && !force) {
                return res.json({ report: record.report_json, cached: true });
            }

            const cues = JSON.parse(record.parsed_transcript);
            const transcriptText = cuesToText(cues);

            const meta = {
                subject:     record.title,
                date:        record.meeting_date
                    ? new Date(record.meeting_date).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
                    : null,
                durationMin: record.duration_min,
                attendees:   (record.attendees_json || []).map(a => a.name || a.email || a).filter(Boolean),
            };

            const { report, tokensUsed, model } = await MeetingSummaryService.summarize(transcriptText, meta);

            await record.update({
                report_json:         report,
                tokens_used:         tokensUsed,
                ai_model:            model,
                report_generated_at: new Date(),
                status:              'summarized',
            });

            res.json({ report, cached: false });
        } catch (err) {
            await db.InPersonMeeting.update(
                { status: 'error', error_message: err.message },
                { where: { id: req.params.id, user_id: req.user.id } }
            ).catch(() => {});
            res.status(500).json({ error: err.message });
        }
    }

    // ── POST /inperson/meetings/:id/email ─────────────────────────────────────
    async emailReport(req, res) {
        if (!guard(req, res)) return;
        try {
            const record = await db.InPersonMeeting.findOne({
                where: { id: req.params.id, user_id: req.user.id },
            });
            if (!record)             return res.status(404).json({ error: 'Reunião não encontrada.' });
            if (!record.report_json) return res.status(400).json({ error: 'Relatório ainda não gerado.' });

            const { recipients, subject, observations } = req.body;
            if (!recipients?.length) return res.status(400).json({ error: 'Informe ao menos um destinatário.' });

            const report = record.report_json;
            const meetingDateFormatted = record.meeting_date
                ? new Date(record.meeting_date).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
                : null;

            const acoes = (report.acoes || []).map(a => ({
                descricao:   a.descricao || a.acao || a.tarefa || '',
                responsavel: a.responsavel || '—',
                prazo:       a.prazo || '—',
            }));

            await sendEmail('meeting.report', recipients, {
                subject:           subject || `Relatório: ${record.title}`,
                meetingSubject:    record.title,
                meetingDate:       meetingDateFormatted,
                durationMin:       record.duration_min,
                organizerName:     record.organizer_name,
                attendees:         (record.attendees_json || []).map(a => a.name || a.email || a).filter(Boolean),
                tags:              report.tags || [],
                sentimentoGeral:   report.sentimento_geral || null,
                observations:      observations || null,
                resumo:            report.resumo || null,
                resumoPreview:     (report.resumo || '').slice(0, 120),
                decisoes:          report.decisoes || [],
                acoes,
                proximosPassos:    report.proximos_passos || [],
                pontosAtencao:     report.pontos_atencao || [],
                kpis:              report.kpis || [],
                joinUrl:           null,
                reportGeneratedAt: record.report_generated_at
                    ? new Date(record.report_generated_at).toLocaleDateString('pt-BR')
                    : null,
            });

            res.json({ ok: true, sentTo: recipients.length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
}

export default new InPersonMeetingController();

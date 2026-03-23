// controllers/microsoft/MicrosoftTranscriptController.js
import transcriptService, { cuesToText } from '../../services/microsoft/MicrosoftTranscriptService.js';
import { MeetingSummaryService } from '../../validatorAI/src/services/MeetingSummaryService.js';
import db from '../../models/sequelize/index.js';

function guard(req, res) {
    if (!req.user.microsoft_id) {
        res.status(401).json({ error: 'Conta Microsoft não conectada.' });
        return false;
    }
    return true;
}

function durationMin(start, end) {
    if (!start || !end) return null;
    return Math.round((new Date(end) - new Date(start)) / 60000);
}

class MicrosoftTranscriptController {

    // ── GET /transcripts/meetings?days=30 ─────────────────────────────────────
    // Lista reuniões recentes do calendário + status de transcrição no nosso DB
    async listMeetings(req, res) {
        if (!guard(req, res)) return;
        try {
            const days = parseInt(req.query.days) || 30;
            const meetings = await transcriptService.getRecentTeamsMeetings(req.user, days);

            // Enriquece com status do nosso banco (sem chamar o Graph API para cada uma)
            const savedRecords = await db.MeetingTranscript.findAll({
                where: { user_id: req.user.id },
                attributes: ['transcript_id', 'meeting_id', 'subject', 'status', 'report_generated_at'],
            });
            const savedMap = {};
            for (const r of savedRecords) savedMap[r.transcript_id] = r;

            res.json(meetings.map(m => ({
                ...m,
                dbStatus: null, // cliente vai verificar individualmente
            })));
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    // ── GET /transcripts/check?joinUrl=... ────────────────────────────────────
    // Verifica se uma reunião tem transcrição disponível no Graph API
    async checkTranscripts(req, res) {
        if (!guard(req, res)) return;
        try {
            const { joinUrl } = req.query;
            if (!joinUrl) return res.status(400).json({ error: 'joinUrl obrigatório' });

            const meetingId = await transcriptService.getMeetingIdByJoinUrl(req.user, joinUrl);
            if (!meetingId) return res.json({ available: false, transcripts: [] });

            const transcripts = await transcriptService.listTranscripts(req.user, meetingId);

            // Verifica quais já temos no banco
            const saved = await db.MeetingTranscript.findAll({
                where: { user_id: req.user.id, meeting_id: meetingId },
                attributes: ['transcript_id', 'status', 'report_generated_at'],
            });
            const savedMap = Object.fromEntries(saved.map(r => [r.transcript_id, r]));

            res.json({
                available: transcripts.length > 0,
                meetingId,
                transcripts: transcripts.map(t => ({
                    ...t,
                    cached: !!savedMap[t.id],
                    status: savedMap[t.id]?.status || null,
                    reportReady: savedMap[t.id]?.status === 'summarized',
                    reportGeneratedAt: savedMap[t.id]?.report_generated_at || null,
                })),
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    // ── GET /transcripts/:meetingId/:transcriptId ─────────────────────────────
    // Retorna a transcrição parseada (busca do Graph API se não estiver no cache)
    async getTranscript(req, res) {
        if (!guard(req, res)) return;
        try {
            const { meetingId, transcriptId } = req.params;
            const { subject, start, end, joinUrl, webLink, organizerName, organizerEmail, attendees } = req.query;

            // Tenta buscar do cache primeiro
            const [record, created] = await db.MeetingTranscript.findOrCreate({
                where: { user_id: req.user.id, transcript_id: transcriptId },
                defaults: {
                    meeting_id:      meetingId,
                    user_id:         req.user.id,
                    transcript_id:   transcriptId,
                    subject:         subject || null,
                    meeting_date:    start ? new Date(start) : null,
                    duration_min:    durationMin(start, end),
                    join_url:        joinUrl || null,
                    web_link:        webLink || null,
                    organizer_name:  organizerName || null,
                    organizer_email: organizerEmail || null,
                    attendees_json:  attendees ? JSON.parse(attendees) : null,
                    status:          'pending',
                },
            });

            // Se já temos a transcrição no cache, retorna imediatamente
            if (!created && record.parsed_transcript) {
                return res.json({
                    id: record.id,
                    cues: JSON.parse(record.parsed_transcript),
                    status: record.status,
                    reportReady: record.status === 'summarized',
                    cached: true,
                });
            }

            // Busca do Graph API
            const cues = await transcriptService.getTranscriptContent(req.user, meetingId, transcriptId);
            const parsedJson = JSON.stringify(cues);

            await record.update({
                parsed_transcript:    parsedJson,
                transcript_char_count: parsedJson.length,
                status: 'transcribed',
            });

            res.json({
                id: record.id,
                cues,
                status: 'transcribed',
                reportReady: false,
                cached: false,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    // ── POST /transcripts/:meetingId/:transcriptId/report ─────────────────────
    // Gera (ou retorna cacheado) o relatório IA para a transcrição
    async generateReport(req, res) {
        if (!guard(req, res)) return;
        try {
            const { meetingId, transcriptId } = req.params;
            const { force = false } = req.body;

            const record = await db.MeetingTranscript.findOne({
                where: { user_id: req.user.id, transcript_id: transcriptId },
            });

            if (!record) return res.status(404).json({ error: 'Transcrição não encontrada. Carregue-a primeiro.' });

            // Retorna cache se já foi gerado e não está forçando regeneração
            if (record.status === 'summarized' && record.report_json && !force) {
                return res.json({ report: record.report_json, cached: true });
            }

            if (!record.parsed_transcript) {
                return res.status(400).json({ error: 'Transcrição ainda não foi baixada. Carregue o conteúdo primeiro.' });
            }

            // Prepara o texto para o prompt
            const cues = JSON.parse(record.parsed_transcript);
            const transcriptText = cuesToText(cues);

            const meta = {
                subject:     record.subject,
                date:        record.meeting_date ? new Date(record.meeting_date).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : null,
                durationMin: record.duration_min,
                attendees:   (record.attendees_json || []).map(a => a.name || a.email).filter(Boolean),
            };

            const { report, tokensUsed, model } = await MeetingSummaryService.summarize(transcriptText, meta);

            await record.update({
                report_json:          report,
                tokens_used:          tokensUsed,
                ai_model:             model,
                report_generated_at:  new Date(),
                status:               'summarized',
            });

            res.json({ report, cached: false });
        } catch (err) {
            await db.MeetingTranscript.update(
                { status: 'error', error_message: err.message },
                { where: { user_id: req.user.id, transcript_id: req.params.transcriptId } }
            ).catch(() => {});
            res.status(500).json({ error: err.message });
        }
    }

    // ── GET /transcripts/reports ──────────────────────────────────────────────
    // Lista todos os relatórios já gerados para o usuário
    async listReports(req, res) {
        if (!guard(req, res)) return;
        try {
            const reports = await db.MeetingTranscript.findAll({
                where: { user_id: req.user.id, status: 'summarized' },
                attributes: [
                    'id', 'meeting_id', 'transcript_id', 'subject',
                    'meeting_date', 'duration_min', 'attendees_json',
                    'organizer_name', 'join_url', 'tokens_used', 'ai_model',
                    'report_generated_at', 'transcript_char_count',
                    // Retorna apenas campos do report_json sem o texto completo (resumo)
                ],
                order: [['meeting_date', 'DESC']],
            });

            res.json(reports.map(r => ({
                id: r.id,
                meetingId: r.meeting_id,
                transcriptId: r.transcript_id,
                subject: r.subject,
                meetingDate: r.meeting_date,
                durationMin: r.duration_min,
                attendees: r.attendees_json,
                organizerName: r.organizer_name,
                joinUrl: r.join_url,
                tokensUsed: r.tokens_used,
                aiModel: r.ai_model,
                reportGeneratedAt: r.report_generated_at,
                charCount: r.transcript_char_count,
                // Preview do resumo
                summaryPreview: r.report_json?.resumo?.slice(0, 200) || null,
                tagsPreview: r.report_json?.tags || [],
                sentimentoGeral: r.report_json?.sentimento_geral || null,
                acaoCount: r.report_json?.acoes?.length || 0,
                kpiCount: r.report_json?.kpis?.length || 0,
            })));
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    // ── GET /transcripts/reports/:id ─────────────────────────────────────────
    // Retorna um relatório completo por ID do banco
    async getReport(req, res) {
        if (!guard(req, res)) return;
        try {
            const record = await db.MeetingTranscript.findOne({
                where: { id: req.params.id, user_id: req.user.id },
            });
            if (!record) return res.status(404).json({ error: 'Relatório não encontrado.' });

            res.json({
                id: record.id,
                subject: record.subject,
                meetingDate: record.meeting_date,
                durationMin: record.duration_min,
                attendees: record.attendees_json,
                organizerName: record.organizer_name,
                joinUrl: record.join_url,
                webLink: record.web_link,
                tokensUsed: record.tokens_used,
                aiModel: record.ai_model,
                reportGeneratedAt: record.report_generated_at,
                cues: record.parsed_transcript ? JSON.parse(record.parsed_transcript) : [],
                report: record.report_json,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
}

export default new MicrosoftTranscriptController();

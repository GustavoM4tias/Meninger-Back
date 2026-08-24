// controllers/microsoft/MicrosoftTranscriptController.js
import transcriptService, { cuesToText } from '../../services/microsoft/MicrosoftTranscriptService.js';
import settingsService from '../../services/microsoft/MicrosoftSettingsService.js';
import { MeetingSummaryService } from '../../validatorAI/src/services/MeetingSummaryService.js';
import { sendEmail } from '../../email/email.service.js';
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

/**
 * Converte um Date (armazenado em UTC) para o horário de parede de São Paulo
 * no mesmo formato das reuniões de calendário (ISO local, sem 'Z'):
 * "2026-07-24T14:30:00". Mantém o front (fmtDate/fmtTime) consistente.
 */
function toSaoPauloLocal(date) {
    if (!date) return null;
    const parts = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date(date));
    return parts.replace(' ', 'T');
}

class MicrosoftTranscriptController {

    // ── GET /transcripts/meetings?days=30 ─────────────────────────────────────
    // Lista reuniões recentes do calendário + status de transcrição no nosso DB
    async listMeetings(req, res) {
        if (!guard(req, res)) return;
        try {
            const days = parseInt(req.query.days) || 30;
            const meetings = await transcriptService.getRecentTeamsMeetings(req.user, days);

            // Reuniões instantâneas não existem no calendário — busca do nosso banco
            // e injeta na mesma listagem (mesmo formato das reuniões de calendário).
            const since = new Date();
            since.setDate(since.getDate() - days);
            const instant = await db.InstantMeeting.findAll({
                where: {
                    user_id: req.user.id,
                    start_at: { [db.Sequelize.Op.gte]: since },
                },
                order: [['start_at', 'DESC']],
            });

            const instantMapped = instant.map(m => ({
                eventId:   m.meeting_id,       // onlineMeeting.id — estável e único
                subject:   m.subject || 'Reunião instantânea',
                start:     toSaoPauloLocal(m.start_at),
                end:       toSaoPauloLocal(m.end_at),
                joinUrl:   m.join_url || null,
                webLink:   m.join_url || null,
                organizer: { name: m.organizer_name, email: m.organizer_email },
                attendees: [],
                isInstant: true,              // flag para o front distinguir visualmente
            }));

            // Mescla e ordena por data (mais recente primeiro)
            const all = [...instantMapped, ...meetings.map(m => ({ ...m, isInstant: false }))]
                .sort((a, b) => new Date(b.start || 0) - new Date(a.start || 0));

            res.json(all);
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

            // 1) Caminho de sempre: a conta da própria pessoa (organizador).
            let meetingId = await transcriptService.getMeetingIdByJoinUrl(req.user, joinUrl);
            let viaApp = false;

            // 2) Não achou: pode ser reunião de que ela só PARTICIPOU. Tenta pelo
            //    organizador com o token de aplicação. Sem consentimento no
            //    portal, isto devolve null e nada muda em relação a antes.
            if (!meetingId) {
                const { transcript_app_fallback } = await settingsService.get();
                if (transcript_app_fallback && req.query.organizerEmail) {
                    const organizerId = await transcriptService.resolveOrganizerId(req.query.organizerEmail);
                    if (organizerId) {
                        meetingId = await transcriptService.getMeetingIdByJoinUrlApp(organizerId, joinUrl);
                        viaApp = !!meetingId;
                    }
                }
            }

            // 3) Ainda não achou. Pode ser que outro participante já tenha
            //    baixado esta mesma reunião aqui dentro - e aí não é preciso
            //    permissão nova nenhuma: a transcrição é a mesma para todos que
            //    estiveram na sala, e o direito de ver vem de ter participado.
            if (!meetingId) {
                const compartilhadas = await transcriptService.findSharedByJoinUrl(joinUrl, req.user);
                if (compartilhadas.length) {
                    const meus = await db.MeetingTranscript.findAll({
                        where: {
                            user_id: req.user.id,
                            transcript_id: compartilhadas.map(c => c.transcript_id),
                        },
                        attributes: ['transcript_id', 'status', 'report_generated_at'],
                    });
                    const meuMap = Object.fromEntries(meus.map(r => [r.transcript_id, r]));
                    const quem = compartilhadas[0].user?.username
                              || compartilhadas[0].organizer_name || 'outro participante';

                    return res.json({
                        available: true,
                        viaShared: true,
                        meetingId: compartilhadas[0].meeting_id,
                        transcripts: compartilhadas.map(c => ({
                            id:                c.transcript_id,
                            createdAt:         c.createdAt,
                            meetingId:         c.meeting_id,
                            cached:            !!meuMap[c.transcript_id],
                            status:            meuMap[c.transcript_id]?.status || null,
                            reportReady:       meuMap[c.transcript_id]?.status === 'summarized' || !!c.report_json,
                            reportGeneratedAt: meuMap[c.transcript_id]?.report_generated_at || c.report_generated_at,
                            sharedFrom:        c.user?.username || c.organizer_name || null,
                            sharedReportReady: !!c.report_json,
                        })),
                        hint: `Você participou desta reunião e ${quem} já carregou a transcrição no Office. Abrir daqui não baixa nada de novo nem gera outro relatório.`,
                    });
                }
            }

            if (!meetingId) {
                return res.json({
                    available: false,
                    transcripts: [],
                    reason: 'meeting_not_found',
                    hint: 'Não foi possível abrir esta reunião pela Microsoft. Reuniões que você organizou funcionam sempre; para as que você apenas participou, basta que alguém que estava na reunião abra a transcrição aqui uma vez - a partir daí ela vale para todos os participantes. Se ninguém abriu ainda, o administrador precisa liberar a permissão de aplicação no portal do Azure.',
                });
            }

            const transcripts = viaApp
                ? await transcriptService.listTranscriptsApp(
                    await transcriptService.resolveOrganizerId(req.query.organizerEmail), meetingId)
                : await transcriptService.listTranscripts(req.user, meetingId);

            if (!transcripts.length) {
                return res.json({
                    available: false,
                    meetingId,
                    transcripts: [],
                    reason: 'no_transcripts',
                    hint: 'Reunião encontrada, mas sem transcrições. A transcrição precisa ter sido iniciada durante a reunião no Teams.',
                });
            }

            // Verifica quais já temos no banco
            const saved = await db.MeetingTranscript.findAll({
                where: { user_id: req.user.id, meeting_id: meetingId },
                attributes: ['transcript_id', 'status', 'report_generated_at'],
            });
            const savedMap = Object.fromEntries(saved.map(r => [r.transcript_id, r]));

            res.json({
                available: true,
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

    // ── GET /transcripts/diagnose?joinUrl=... ─────────────────────────────────
    // Endpoint de diagnóstico — retorna dados brutos do Graph API para depuração
    async diagnose(req, res) {
        if (!guard(req, res)) return;
        try {
            const { joinUrl } = req.query;
            if (!joinUrl) return res.status(400).json({ error: 'joinUrl obrigatório' });
            const result = await transcriptService.diagnoseMeeting(req.user, joinUrl);
            res.json(result);
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

            // Busca do Graph API. Se a conta da pessoa não alcança a reunião
            // (ela só participou), tenta pelo organizador com token de aplicação.
            let cues;
            try {
                cues = await transcriptService.getTranscriptContent(req.user, meetingId, transcriptId);
            } catch (err) {
                const { transcript_app_fallback } = await settingsService.get();
                const organizerId = transcript_app_fallback && organizerEmail
                    ? await transcriptService.resolveOrganizerId(organizerEmail)
                    : null;

                let viaApp = false;
                if (organizerId) {
                    try {
                        cues = await transcriptService.getTranscriptContentApp(organizerId, meetingId, transcriptId);
                        viaApp = true;
                    } catch { /* cai no caminho compartilhado abaixo */ }
                }

                // Terceiro caminho: outro participante já baixou esta mesma
                // transcrição. Não custa permissão nova, e é o que faz quem só
                // participou ter relatório hoje, sem esperar liberação no Azure.
                if (!viaApp) {
                    const origem = await transcriptService.findShared(transcriptId, req.user, 'transcricao');
                    if (!origem) throw err;

                    await transcriptService.copiarDeCompartilhado(record, origem, { comRelatorio: true });
                    return res.json({
                        id:          record.id,
                        cues:        JSON.parse(record.parsed_transcript),
                        status:      record.status,
                        reportReady: record.status === 'summarized',
                        cached:      true,
                        sharedFrom:  record.shared_from_name,
                    });
                }
            }
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
                return res.json({
                    report: record.report_json,
                    cached: true,
                    sharedFrom: record.shared_from_name || null,
                });
            }

            // Outro participante já pagou este relatório? A transcrição tem id
            // próprio e é a MESMA para todo mundo que esteve na reunião: gerar
            // de novo é queimar token de IA pelo mesmo conteúdo. `force` continua
            // regerando de propósito, para quando o relatório saiu ruim.
            if (!force) {
                const origem = await transcriptService.findShared(transcriptId, req.user, 'relatorio');
                if (origem) {
                    await transcriptService.copiarDeCompartilhado(record, origem, { comRelatorio: true });
                    return res.json({
                        report:     record.report_json,
                        cached:     true,
                        sharedFrom: record.shared_from_name,
                        sharedAt:   record.report_generated_at,
                    });
                }
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

    // ── POST /transcripts/reports/:id/email ───────────────────────────────────
    // Envia o relatório por e-mail para os destinatários informados
    async emailReport(req, res) {
        if (!guard(req, res)) return;
        try {
            const record = await db.MeetingTranscript.findOne({
                where: { id: req.params.id, user_id: req.user.id },
            });
            if (!record) return res.status(404).json({ error: 'Relatório não encontrado.' });
            if (!record.report_json) return res.status(400).json({ error: 'Relatório ainda não foi gerado.' });

            const { recipients, subject, observations } = req.body;
            if (!recipients?.length) return res.status(400).json({ error: 'Informe ao menos um destinatário.' });

            const report = record.report_json;
            const meetingDateFormatted = record.meeting_date
                ? new Date(record.meeting_date).toLocaleDateString('pt-BR', {
                      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
                  })
                : null;

            const acoes = (report.acoes || []).map(a => ({
                descricao:   a.descricao || a.acao || '',
                responsavel: a.responsavel || '—',
                prazo:       a.prazo || '—',
            }));

            const templateData = {
                subject:           subject || `Relatório de Reunião: ${record.subject || 'Reunião'}`,
                meetingSubject:    record.subject || '(Sem título)',
                meetingDate:       meetingDateFormatted,
                durationMin:       record.duration_min,
                organizerName:     record.organizer_name,
                attendees:         (record.attendees_json || []).map(a => a.name || a.email).filter(Boolean),
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
                joinUrl:           record.join_url || null,
                reportGeneratedAt: record.report_generated_at
                    ? new Date(record.report_generated_at).toLocaleDateString('pt-BR')
                    : null,
            };

            await sendEmail('meeting.report', recipients, templateData);

            res.json({ ok: true, sentTo: recipients.length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
}

export default new MicrosoftTranscriptController();

// services/microsoft/MicrosoftTranscriptService.js
import axios from 'axios';
import graph from './MicrosoftGraphService.js';
import microsoftAuthService from './MicrosoftAuthService.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// ── VTT Parser ────────────────────────────────────────────────────────────────

function vttTimestampToSec(ts) {
    const parts = ts.trim().split(':');
    if (parts.length === 3) {
        return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
    }
    return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
}

function parseVTT(vttText) {
    const lines = vttText.split('\n');
    const cues = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i].trim();

        if (line.includes('-->')) {
            const [startStr] = line.split(' --> ');
            i++;

            let speaker = '';
            const textParts = [];

            while (i < lines.length && lines[i].trim() !== '') {
                const textLine = lines[i].trim();
                // Formato Teams VTT: <v Speaker Name>texto da fala
                const voiceMatch = textLine.match(/^<v\s+([^>]+)>(.*)/s);
                if (voiceMatch) {
                    speaker = voiceMatch[1].trim();
                    textParts.push(voiceMatch[2].trim());
                } else {
                    // Linha de continuação sem tag <v>
                    textParts.push(textLine.replace(/<[^>]*>/g, '').trim()); // remove outras tags HTML
                }
                i++;
            }

            const text = textParts.filter(Boolean).join(' ').trim();
            if (text) {
                cues.push({
                    speaker: speaker || 'Desconhecido',
                    startSec: vttTimestampToSec(startStr),
                    startStr: startStr.trim(),
                    text,
                });
            }
        } else {
            i++;
        }
    }

    return cues;
}

/** Converte cues em texto legível para o prompt da IA */
export function cuesToText(cues) {
    return cues.map(c => `[${c.startStr}] ${c.speaker}: ${c.text}`).join('\n');
}

// ── Graph API helpers ─────────────────────────────────────────────────────────

/** GET autenticado com token fresco — necessário para URLs absolutas do Graph */
async function graphGet(user, path, params) {
    const token = await microsoftAuthService.getValidToken(user);
    if (!token) throw new Error('Sessão Microsoft expirada.');
    const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;
    const { data } = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        params,
    });
    return data;
}

// ── Transcript Service ────────────────────────────────────────────────────────

class MicrosoftTranscriptService {

    /**
     * Resolve o onlineMeeting.id a partir da joinUrl de um evento de calendário.
     * Necessário para acessar /me/onlineMeetings/{id}/transcripts.
     * Retorna null se a reunião não foi criada por este usuário.
     */
    async getMeetingIdByJoinUrl(user, joinUrl) {
        try {
            // Usa params para que axios codifique corretamente a URL do joinUrl
            // (URLs do Teams contêm & e outros chars que quebram a query string inline)
            const data = await graph.get(user, '/me/onlineMeetings', {
                '$filter': `joinWebUrl eq '${joinUrl}'`,
                '$select': 'id,subject',
            });
            return data.value?.[0]?.id || null;
        } catch {
            return null;
        }
    }

    /**
     * Lista as transcrições disponíveis para um onlineMeeting.
     * Retorna [] se nenhuma transcrição foi gerada.
     */
    async listTranscripts(user, meetingId) {
        try {
            const data = await graph.get(user, `/me/onlineMeetings/${meetingId}/transcripts`);
            return (data.value || []).map(t => ({
                id: t.id,
                createdAt: t.createdDateTime,
                meetingId,
            }));
        } catch {
            return [];
        }
    }

    /**
     * Baixa o conteúdo VTT de uma transcrição e retorna os cues parseados.
     * Usa requisição direta com token pois a URL do conteúdo é diferente da API padrão.
     */
    async getTranscriptContent(user, meetingId, transcriptId) {
        const token = await microsoftAuthService.getValidToken(user);
        if (!token) throw new Error('Sessão Microsoft expirada.');

        const { data: vttText } = await axios.get(
            `${GRAPH_BASE}/me/onlineMeetings/${meetingId}/transcripts/${transcriptId}/content`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'text/vtt',
                },
                responseType: 'text',
            }
        );

        const cues = parseVTT(vttText);
        return cues;
    }

    /**
     * Busca reuniões recentes do calendário (com isOnlineMeeting: true)
     * para os últimos `days` dias.
     */
    async getRecentTeamsMeetings(user, days = 30) {
        const end   = new Date();
        const start = new Date();
        start.setDate(start.getDate() - days);

        const qs = new URLSearchParams({
            startDateTime: start.toISOString(),
            endDateTime:   end.toISOString(),
            $select: 'id,subject,start,end,isOnlineMeeting,onlineMeeting,organizer,attendees,webLink',
            $filter: 'isOnlineMeeting eq true',
            $orderby: 'start/dateTime desc',
            $top: '50',
        });

        const data = await graph.get(user, `/me/calendarView?${qs}`);
        return (data.value || []).map(e => ({
            eventId:     e.id,
            subject:     e.subject || '(Sem título)',
            start:       e.start?.dateTime || null,
            end:         e.end?.dateTime || null,
            joinUrl:     e.onlineMeeting?.joinUrl || null,
            webLink:     e.webLink || null,
            organizer:   { name: e.organizer?.emailAddress?.name, email: e.organizer?.emailAddress?.address },
            attendees:   (e.attendees || []).map(a => ({ name: a.emailAddress?.name, email: a.emailAddress?.address })),
        }));
    }
}

export default new MicrosoftTranscriptService();

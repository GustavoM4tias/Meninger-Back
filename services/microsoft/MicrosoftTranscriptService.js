// services/microsoft/MicrosoftTranscriptService.js
import axios from 'axios';
import graph from './MicrosoftGraphService.js';
import microsoftAuthService from './MicrosoftAuthService.js';

const GRAPH_BASE      = 'https://graph.microsoft.com/v1.0';
const GRAPH_BASE_BETA = 'https://graph.microsoft.com/beta';

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
        const safe = (fn) => { try { return fn(); } catch { return null; } };
        const decodedBase = safe(() => decodeURIComponent(joinUrl).split('?')[0]);
        const originalBase = joinUrl.split('?')[0];

        // ── NOTA: /me/onlineMeetings só aceita $filter=joinWebUrl — sem $select, $top, $skip ──

        // Strategy 1: $filter=joinWebUrl (endpoint aceita APENAS este OData option)
        const filterVariants = [
            decodedBase,
            safe(() => decodeURIComponent(joinUrl)),
            originalBase,
            joinUrl,
        ].filter((v, i, arr) => v && arr.indexOf(v) === i);

        for (const base of [GRAPH_BASE_BETA, GRAPH_BASE]) {
            for (const variant of filterVariants) {
                try {
                    // IMPORTANTE: sem $select nem qualquer outro param além de $filter
                    const filter = encodeURIComponent(`joinWebUrl eq '${variant}'`);
                    const data   = await graphGet(user, `${base}/me/onlineMeetings?$filter=${filter}`);
                    const id     = data.value?.[0]?.id;
                    if (id) {
                        console.log('[Transcript] getMeetingIdByJoinUrl ✓ via $filter', base.includes('beta') ? '[beta]' : '[v1.0]');
                        return id;
                    }
                } catch (err) {
                    const status = err?.response?.status;
                    if (status === 403) return null;
                    // 400/500 → tenta próxima variante
                }
            }
        }

        // Strategy 2: Listar TODAS as reuniões (sem nenhum OData option) e comparar
        for (const base of [GRAPH_BASE_BETA, GRAPH_BASE]) {
            try {
                // Sem $select, $top ou qualquer outro param — endpoint não suporta
                const data     = await graphGet(user, `${base}/me/onlineMeetings`);
                const meetings = data.value || [];
                for (const m of meetings) {
                    if (!m.joinWebUrl) continue;
                    const storedBase    = m.joinWebUrl.split('?')[0];
                    const storedDecoded = safe(() => decodeURIComponent(storedBase));
                    if (
                        storedBase    === originalBase ||
                        storedBase    === decodedBase  ||
                        storedDecoded === decodedBase  ||
                        storedDecoded === originalBase
                    ) {
                        console.log('[Transcript] getMeetingIdByJoinUrl ✓ via list+match', base.includes('beta') ? '[beta]' : '[v1.0]');
                        return m.id;
                    }
                }
            } catch (err) {
                const status = err?.response?.status;
                if (status === 403) return null;
            }
        }

        console.warn('[Transcript] getMeetingIdByJoinUrl: reunião não encontrada.');
        return null;
    }

    /**
     * Diagnóstico: retorna dados brutos do Graph API para debug.
     * Chame GET /transcripts/diagnose?joinUrl=... para investigar.
     */
    async diagnoseMeeting(user, joinUrl) {
        const safe = (fn) => { try { return fn(); } catch { return null; } };
        const decodedBase = safe(() => decodeURIComponent(joinUrl).split('?')[0]);
        const originalBase = joinUrl.split('?')[0];
        const variants = [
            decodedBase,
            safe(() => decodeURIComponent(joinUrl)),
            originalBase,
            joinUrl,
        ].filter((v, i, arr) => v && arr.indexOf(v) === i);

        const result = {
            joinUrlReceived: joinUrl,
            filter_tests: [],
            list_test: null,
            onlineMeetingFound: null,
            transcripts: [],
        };

        // ── Testa $filter=joinWebUrl (SEM $select — endpoint não suporta) ────────
        for (const base of [GRAPH_BASE_BETA, GRAPH_BASE]) {
            const label       = base.includes('beta') ? 'beta' : 'v1.0';
            const testVariant = decodedBase || variants[0];
            const entry       = { endpoint: label, variant: testVariant?.substring(0, 100), found: false };
            try {
                // Apenas $filter — sem $select, $top ou qualquer outro OData option
                const filter = encodeURIComponent(`joinWebUrl eq '${testVariant}'`);
                const data   = await graphGet(user, `${base}/me/onlineMeetings?$filter=${filter}`);
                entry.status = 200;
                entry.count  = data.value?.length || 0;
                if (data.value?.length) {
                    entry.found            = true;
                    entry.meetingId        = data.value[0].id;
                    entry.storedJoinWebUrl = data.value[0].joinWebUrl;
                    if (!result.onlineMeetingFound) result.onlineMeetingFound = data.value[0].id;
                }
            } catch (err) {
                entry.status      = err?.response?.status;
                entry.errorCode   = err?.response?.data?.error?.code;
                entry.errorMsg    = err?.response?.data?.error?.message;
                entry.errorDetail = err?.response?.data?.error?.innerError || null;
            }
            result.filter_tests.push(entry);
        }

        // ── Testa list sem filtro (sem $select, $top — endpoint não suporta) ───
        for (const base of [GRAPH_BASE_BETA, GRAPH_BASE]) {
            const label = base.includes('beta') ? 'beta' : 'v1.0';
            try {
                // Sem nenhum OData option — endpoint não suporta $select nem $top
                const data     = await graphGet(user, `${base}/me/onlineMeetings`);
                const meetings = data.value || [];
                result.list_test = {
                    endpoint: label,
                    totalReturned: meetings.length,
                    sampleUrls: meetings.slice(0, 3).map(m => m.joinWebUrl?.substring(0, 80)),
                };
                for (const m of meetings) {
                    if (!m.joinWebUrl) continue;
                    const storedBase    = m.joinWebUrl.split('?')[0];
                    const storedDecoded = safe(() => decodeURIComponent(storedBase));
                    if (storedBase === originalBase || storedBase === decodedBase ||
                        storedDecoded === decodedBase || storedDecoded === originalBase) {
                        result.list_test.matched   = true;
                        result.list_test.matchedId = m.id;
                        result.list_test.matchedUrl = m.joinWebUrl?.substring(0, 100);
                        result.onlineMeetingFound  = m.id;
                        break;
                    }
                }
                break;
            } catch (err) {
                result.list_test = {
                    endpoint: label,
                    status:    err?.response?.status,
                    errorCode: err?.response?.data?.error?.code,
                    errorMsg:  err?.response?.data?.error?.message,
                };
            }
        }

        // ── Busca transcrições se encontrou o meeting ──────────────────────────
        if (result.onlineMeetingFound) {
            for (const base of [GRAPH_BASE_BETA, GRAPH_BASE]) {
                try {
                    const tData = await graphGet(user, `${base}/me/onlineMeetings/${result.onlineMeetingFound}/transcripts`);
                    result.transcripts = (tData.value || []).map(t => ({ id: t.id, createdDateTime: t.createdDateTime }));
                    result.transcriptEndpoint = base.includes('beta') ? 'beta' : 'v1.0';
                    break;
                } catch (err) {
                    result.transcriptError = {
                        status: err?.response?.status,
                        code:   err?.response?.data?.error?.code,
                        msg:    err?.response?.data?.error?.message,
                    };
                }
            }
        }

        return result;
    }

    /**
     * Lista as transcrições disponíveis para um onlineMeeting.
     * Retorna [] se nenhuma transcrição foi gerada ou se sem permissão.
     */
    async listTranscripts(user, meetingId) {
        // Tenta beta primeiro (mais permissivo), depois v1.0
        for (const base of [GRAPH_BASE_BETA, GRAPH_BASE]) {
            try {
                const data = await graphGet(user, `${base}/me/onlineMeetings/${meetingId}/transcripts`);
                return (data.value || []).map(t => ({
                    id:        t.id,
                    createdAt: t.createdDateTime,
                    meetingId,
                }));
            } catch (err) {
                const status = err?.response?.status;
                if (status === 403) {
                    console.warn('[Transcript] listTranscripts: sem permissão (403). Verifique OnlineMeetingTranscript.Read.All no Azure.');
                    return [];
                }
                if (status !== 404) {
                    console.warn('[Transcript] listTranscripts error', base.includes('beta') ? '[beta]' : '[v1.0]', status, err.message);
                }
            }
        }
        return [];
    }

    /**
     * Baixa o conteúdo VTT de uma transcrição e retorna os cues parseados.
     * Usa requisição direta com token pois a URL do conteúdo é diferente da API padrão.
     */
    async getTranscriptContent(user, meetingId, transcriptId) {
        const token = await microsoftAuthService.getValidToken(user);
        if (!token) throw new Error('Sessão Microsoft expirada.');

        // Tenta beta primeiro, depois v1.0
        let lastError;
        for (const base of [GRAPH_BASE_BETA, GRAPH_BASE]) {
            try {
                const { data: vttText } = await axios.get(
                    `${base}/me/onlineMeetings/${meetingId}/transcripts/${transcriptId}/content`,
                    {
                        headers: {
                            Authorization: `Bearer ${token}`,
                            Accept: 'text/vtt',
                        },
                        responseType: 'text',
                    }
                );
                return parseVTT(vttText);
            } catch (err) {
                lastError = err;
                const status = err?.response?.status;
                if (status === 403 || status === 404) throw err; // não adianta tentar outro endpoint
            }
        }
        throw lastError;
    }

    /**
     * Busca reuniões recentes do calendário (com isOnlineMeeting: true)
     * para os últimos `days` dias.
     *
     * NOTA: /me/calendarView NÃO suporta $filter nem $orderby —
     * filtramos e ordenamos no lado do servidor após receber os dados.
     */
    async getRecentTeamsMeetings(user, days = 30) {
        const end   = new Date();
        const start = new Date();
        start.setDate(start.getDate() - days);

        // Usa params object para que axios codifique corretamente (sem $filter/$orderby)
        const data = await graph.get(
            user,
            '/me/calendarView',
            {
                startDateTime: start.toISOString(),
                endDateTime:   end.toISOString(),
                $select: 'id,subject,start,end,isOnlineMeeting,onlineMeeting,organizer,attendees,webLink',
                $top: '100',
            },
            { Prefer: 'outlook.timezone="America/Sao_Paulo"' }
        );

        return (data.value || [])
            .filter(e => e.isOnlineMeeting && e.onlineMeeting?.joinUrl)
            .sort((a, b) => new Date(b.start?.dateTime || 0) - new Date(a.start?.dateTime || 0))
            .map(e => ({
                eventId:   e.id,
                subject:   e.subject || '(Sem título)',
                start:     e.start?.dateTime || null,
                end:       e.end?.dateTime || null,
                joinUrl:   e.onlineMeeting?.joinUrl || null,
                webLink:   e.webLink || null,
                organizer: { name: e.organizer?.emailAddress?.name, email: e.organizer?.emailAddress?.address },
                attendees: (e.attendees || []).map(a => ({ name: a.emailAddress?.name, email: a.emailAddress?.address })),
            }));
    }
}

export default new MicrosoftTranscriptService();

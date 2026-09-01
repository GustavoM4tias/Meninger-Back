// services/microsoft/MicrosoftTranscriptService.js
import axios from 'axios';
import graph from './MicrosoftGraphService.js';
import microsoftAuthService from './MicrosoftAuthService.js';
import settingsService from './MicrosoftSettingsService.js';
import db from '../../models/sequelize/index.js';
import { MeetingSummaryService } from '../../validatorAI/src/services/MeetingSummaryService.js';

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

// ── Janela da OCORRÊNCIA ──────────────────────────────────────────────────────
//
// Reunião RECORRENTE compartilha o MESMO onlineMeeting (e o mesmo joinUrl) em
// todas as ocorrências, e as transcrições de todas elas se acumulam na mesma
// lista do Graph. Sem este filtro, "a transcrição da reunião" era sempre a mais
// recente da SÉRIE: a ata da semana passada colava na reunião de hoje e a de
// hoje ficava como "sem transcrição".
//
// A transcrição nasce DURANTE a reunião, então o createdAt dela cai entre o
// início e o fim da ocorrência. As margens absorvem a diferença de fuso (o
// calendário devolve hora de parede de São Paulo, o Graph devolve UTC) e
// reunião que estourou o horário.

const OCORRENCIA_ANTES_MS  = 6 * 60 * 60_000;
const OCORRENCIA_DEPOIS_MS = 12 * 60 * 60_000;

/** Transcrições cujo createdAt cai na janela desta ocorrência. Sem data de
 *  início, devolve a lista inteira (comportamento antigo, reunião avulsa). */
export function filtrarPorOcorrencia(transcricoes, start, end) {
    const inicio = start ? new Date(start).getTime() : NaN;
    if (!Number.isFinite(inicio)) return transcricoes;
    const fim = end ? new Date(end).getTime() : inicio;
    const de  = inicio - OCORRENCIA_ANTES_MS;
    const ate = (Number.isFinite(fim) ? fim : inicio) + OCORRENCIA_DEPOIS_MS;
    return transcricoes.filter(t => {
        const c = new Date(t.createdAt || 0).getTime();
        return c >= de && c <= ate;
    });
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

    // ── Caminho de APLICAÇÃO (participante) ──────────────────────────────────
    //
    // O caminho delegado (/me/onlineMeetings) só enxerga reunião que a PRÓPRIA
    // pessoa organizou — quem apenas participou recebia "reunião não encontrada"
    // e ficava sem relatório. Com permissão de aplicação consentida e uma
    // política de acesso a aplicativo no tenant, dá para ler a reunião pelo id
    // do ORGANIZADOR.
    //
    // Tudo aqui é best-effort: sem o consentimento, cada método devolve null e o
    // comportamento volta a ser exatamente o de antes.

    /** microsoft_id do organizador, pelo cadastro do Office ou pelo diretório. */
    async resolveOrganizerId(organizerEmail) {
        if (!organizerEmail) return null;

        const local = await db.User.findOne({
            where: db.Sequelize.where(
                db.Sequelize.fn('lower', db.Sequelize.col('email')),
                String(organizerEmail).trim().toLowerCase()
            ),
            attributes: ['microsoft_id'],
        }).catch(() => null);

        if (local?.microsoft_id) return local.microsoft_id;

        try {
            const found = await graph.appGet(`/users/${encodeURIComponent(organizerEmail)}?$select=id`);
            return found?.id || null;
        } catch {
            return null;
        }
    }

    async getMeetingIdByJoinUrlApp(organizerId, joinUrl) {
        if (!organizerId || !joinUrl) return null;
        const safe = (fn) => { try { return fn(); } catch { return null; } };
        const variants = [
            safe(() => decodeURIComponent(joinUrl).split('?')[0]),
            joinUrl.split('?')[0],
        ].filter((v, i, arr) => v && arr.indexOf(v) === i);

        for (const variant of variants) {
            try {
                const filter = `joinWebUrl eq '${variant}'`;
                const data = await graph.appGet(`/users/${organizerId}/onlineMeetings`, { $filter: filter });
                const id = data?.value?.[0]?.id;
                if (id) {
                    console.log('[Transcript] reunião resolvida pelo token de aplicação (participante).');
                    return id;
                }
            } catch (err) {
                // 403 = permissão de aplicação ou política de acesso ausente.
                if (err?.response?.status === 403) return null;
            }
        }
        return null;
    }

    async listTranscriptsApp(organizerId, meetingId) {
        try {
            const data = await graph.appGet(`/users/${organizerId}/onlineMeetings/${meetingId}/transcripts`);
            return (data?.value || []).map(t => ({ id: t.id, createdAt: t.createdDateTime, meetingId }));
        } catch {
            return [];
        }
    }

    async getTranscriptContentApp(organizerId, meetingId, transcriptId) {
        const token = await microsoftAuthService.getAppToken();
        const { data: vttText } = await axios.get(
            `${GRAPH_BASE}/users/${organizerId}/onlineMeetings/${meetingId}/transcripts/${transcriptId}/content`,
            { headers: { Authorization: `Bearer ${token}`, Accept: 'text/vtt' }, responseType: 'text' }
        );
        return parseVTT(vttText);
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

        // Usa params object para que axios codifique corretamente (sem $filter/$orderby).
        // getAllPages segue o @odata.nextLink — antes o período parava na primeira
        // página e reuniões antigas sumiam da listagem sem aviso.
        const cap = await settingsService.listCap();
        const { items } = await graph.getAllPages(
            user,
            '/me/calendarView',
            {
                startDateTime: start.toISOString(),
                endDateTime:   end.toISOString(),
                $select: 'id,subject,start,end,isOnlineMeeting,onlineMeeting,organizer,attendees,webLink',
                $top: '100',
            },
            { max: cap, headers: { Prefer: 'outlook.timezone="America/Sao_Paulo"' } }
        );

        return items
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

    // ── Ata pronta sem ninguém pedir ──────────────────────────────────────────
    //
    // O caminho antigo era todo puxado: a pessoa abria a tela, clicava na
    // reunião, esperava a busca, mandava carregar a transcrição e só então
    // pedia o relatório. Quatro passos manuais depois de a reunião acabar - e
    // se a transcrição ainda estivesse sendo processada pelo Teams (o que
    // acontece sempre que a reunião foi GRAVADA, porque o vídeo entra na fila
    // junto), o resultado era "sem transcrição" e a pessoa desistia.
    //
    // Aqui isso vira uma coisa só, que o scheduler repete enquanto a reunião
    // for recente: achar, baixar e resumir. Quem abrir a tela depois encontra
    // tudo pronto; quem não abrir recebe a notificação do mesmo jeito.

    /**
     * Gera o relatório de IA para um registro que já tem transcrição.
     * Reaproveita relatório de outro participante quando existe: a transcrição
     * é a mesma, e pagar duas vezes pelo mesmo texto é desperdício.
     */
    async gerarRelatorio(record, user, { forcar = false } = {}) {
        if (record.report_json && !forcar) return { report: record.report_json, reaproveitado: true };

        if (!forcar) {
            const origem = await this.findShared(record.transcript_id, user, 'relatorio');
            if (origem) {
                await this.copiarDeCompartilhado(record, origem, { comRelatorio: true });
                return { report: record.report_json, reaproveitado: true, de: record.shared_from_name };
            }
        }

        if (!record.parsed_transcript) throw new Error('Transcrição ainda não baixada.');

        const cues = JSON.parse(record.parsed_transcript);
        const { report, tokensUsed, model } = await MeetingSummaryService.summarize(cuesToText(cues), {
            subject: record.subject,
            date: record.meeting_date
                ? new Date(record.meeting_date).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
                : null,
            durationMin: record.duration_min,
            attendees: (record.attendees_json || []).map(a => a.name || a.email).filter(Boolean),
        });

        await record.update({
            report_json: report,
            tokens_used: tokensUsed,
            ai_model: model,
            report_generated_at: new Date(),
            status: 'summarized',
        });

        return { report, reaproveitado: false };
    }

    /**
     * Achar, baixar e resumir a transcrição de UMA reunião do calendário.
     *
     * @param {object} user    dono do token
     * @param {object} reuniao item de getRecentTeamsMeetings
     * @returns {{estado: string, record?: object, gerado?: boolean}}
     *   estado: 'sem-link' | 'sem-reuniao' | 'sem-transcricao' | 'pronto'
     */
    async garantirAta(user, reuniao, { gerarRelatorio = true } = {}) {
        if (!reuniao?.joinUrl) return { estado: 'sem-link' };

        // 1) A reunião, pelo caminho da pessoa e depois pelo do organizador.
        let meetingId = await this.getMeetingIdByJoinUrl(user, reuniao.joinUrl);
        let organizerId = null;

        if (!meetingId) {
            const { transcript_app_fallback } = await settingsService.get();
            const email = reuniao.organizer?.email;
            if (transcript_app_fallback && email) {
                organizerId = await this.resolveOrganizerId(email);
                if (organizerId) meetingId = await this.getMeetingIdByJoinUrlApp(organizerId, reuniao.joinUrl);
            }
        }
        if (!meetingId) return { estado: 'sem-reuniao' };

        // 2) As transcrições.
        const transcricoes = organizerId
            ? await this.listTranscriptsApp(organizerId, meetingId)
            : await this.listTranscripts(user, meetingId);
        if (!transcricoes.length) return { estado: 'sem-transcricao' };

        // Só as transcrições DESTA ocorrência: em série recorrente, a lista traz
        // as das semanas anteriores também, e a mais recente da série não é
        // necessariamente a da reunião pedida.
        const daOcorrencia = filtrarPorOcorrencia(transcricoes, reuniao.start, reuniao.end);
        if (!daOcorrencia.length) return { estado: 'sem-transcricao' };

        // A mais recente é a que interessa: reunião que parou e voltou gera mais de uma.
        const alvo = daOcorrencia.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];

        const [record] = await db.MeetingTranscript.findOrCreate({
            where: { user_id: user.id, transcript_id: alvo.id },
            defaults: {
                meeting_id:      meetingId,
                user_id:         user.id,
                transcript_id:   alvo.id,
                subject:         reuniao.subject || null,
                meeting_date:    reuniao.start ? new Date(reuniao.start) : null,
                duration_min:    reuniao.start && reuniao.end
                    ? Math.round((new Date(reuniao.end) - new Date(reuniao.start)) / 60000) : null,
                join_url:        reuniao.joinUrl,
                web_link:        reuniao.webLink || null,
                organizer_name:  reuniao.organizer?.name || null,
                organizer_email: reuniao.organizer?.email || null,
                attendees_json:  reuniao.attendees || null,
                status:          'pending',
            },
        });

        // 3) O conteúdo.
        if (!record.parsed_transcript) {
            const cues = organizerId
                ? await this.getTranscriptContentApp(organizerId, meetingId, alvo.id)
                : await this.getTranscriptContent(user, meetingId, alvo.id);
            const json = JSON.stringify(cues);
            await record.update({
                parsed_transcript: json,
                transcript_char_count: json.length,
                status: 'transcribed',
            });
        }

        // 4) O relatório.
        let gerado = false;
        if (gerarRelatorio && !record.report_json) {
            const r = await this.gerarRelatorio(record, user);
            gerado = !r.reaproveitado;
        }

        return { estado: 'pronto', record, gerado };
    }

    /**
     * Espelha a ata para os OUTROS participantes que têm conta no Office.
     *
     * Linha leve de propósito: só o relatório e os metadados, sem copiar o
     * texto da transcrição. Ele é grande e a pessoa talvez nunca abra; se
     * abrir, o caminho compartilhado copia na hora.
     *
     * @returns {number[]} ids de quem passou a ter a ata agora
     */
    async espelharParaParticipantes(record) {
        const emails = [
            ...(record.attendees_json || []).map(a => a?.email),
            record.organizer_email,
        ].map(e => String(e || '').trim().toLowerCase()).filter(Boolean);

        if (!emails.length) return [];

        const pessoas = await db.User.findAll({
            where: {
                status: true,
                id: { [db.Sequelize.Op.ne]: record.user_id },
                email: { [db.Sequelize.Op.in]: [...new Set(emails)] },
            },
            attributes: ['id', 'email'],
        });

        const novos = [];
        for (const p of pessoas) {
            const [linha, criada] = await db.MeetingTranscript.findOrCreate({
                where: { user_id: p.id, transcript_id: record.transcript_id },
                defaults: {
                    meeting_id:      record.meeting_id,
                    user_id:         p.id,
                    transcript_id:   record.transcript_id,
                    subject:         record.subject,
                    meeting_date:    record.meeting_date,
                    duration_min:    record.duration_min,
                    join_url:        record.join_url,
                    web_link:        record.web_link,
                    organizer_name:  record.organizer_name,
                    organizer_email: record.organizer_email,
                    attendees_json:  record.attendees_json,
                    report_json:     record.report_json,
                    ai_model:        record.ai_model,
                    report_generated_at: record.report_generated_at,
                    tokens_used:     0,
                    shared_from_id:  record.id,
                    shared_from_name: record.organizer_name || null,
                    status:          record.report_json ? 'summarized' : 'pending',
                },
            });

            if (criada) { novos.push(p.id); continue; }

            // Já existia sem relatório (a pessoa abriu a tela antes de a ata
            // ficar pronta): completa em vez de deixar pela metade.
            if (!linha.report_json && record.report_json) {
                await linha.update({
                    report_json: record.report_json,
                    ai_model: record.ai_model,
                    report_generated_at: record.report_generated_at,
                    shared_from_id: record.id,
                    shared_from_name: record.organizer_name || null,
                    status: 'summarized',
                });
                novos.push(p.id);
            }
        }

        return novos;
    }

    // ── Reaproveitar o que outro participante já baixou ───────────────────────
    //
    // A transcrição tem id próprio no Graph e é a MESMA para todo mundo que
    // esteve na reunião. Sem o que vem abaixo, cada participante baixava de novo
    // e pagava outro relatório de IA pelo mesmo conteúdo - quando conseguia,
    // porque o caminho delegado só alcança reunião que a própria pessoa
    // ORGANIZOU, e a de aplicação depende de liberação no tenant que ainda não
    // saiu.
    //
    // A regra de acesso aqui é PARTICIPAÇÃO, não posse: quem está na lista de
    // participantes do registro já salvo (ou é o organizador dele) enxerga o que
    // está lá. Quem não está não enxerga nada, mesmo com o id na mão - o id vem
    // da URL e nunca é credencial.

    /** A pessoa esteve nesta reunião, segundo o registro já salvo? */
    participou(record, user) {
        if (!record) return false;
        if (record.user_id === user.id) return true;

        const meu = String(user?.email || '').trim().toLowerCase();
        if (!meu) return false;
        if (String(record.organizer_email || '').trim().toLowerCase() === meu) return true;

        const lista = Array.isArray(record.attendees_json) ? record.attendees_json : [];
        return lista.some(a => String(a?.email || '').trim().toLowerCase() === meu);
    }

    /**
     * Registro de OUTRA pessoa para a mesma transcrição, quando o solicitante
     * participou da reunião.
     * @param {'transcricao'|'relatorio'} exige - o que o registro precisa ter
     */
    async findShared(transcriptId, user, exige = 'transcricao') {
        const linhas = await db.MeetingTranscript.findAll({
            where: { transcript_id: transcriptId },
            include: [{ model: db.User, as: 'user', attributes: ['id', 'username'] }],
            order: [['report_generated_at', 'ASC'], ['created_at', 'ASC']],
        });

        for (const l of linhas) {
            if (l.user_id === user.id) continue;
            if (exige === 'relatorio' ? !l.report_json : !l.parsed_transcript) continue;
            if (!this.participou(l, user)) continue;
            return l;
        }
        return null;
    }

    /**
     * Reunião já salva por alguém, achada pelo link de entrada.
     *
     * É o caminho de quem só PARTICIPOU: o Graph não devolve a reunião para ela,
     * mas o organizador já baixou a transcrição aqui dentro. O link é comparado
     * sem a query string, que muda de convite para convite.
     *
     * `start` recorta pela ocorrência: série recorrente tem o mesmo joinUrl em
     * todas as semanas, e sem o recorte a ata da semana passada era devolvida
     * como se fosse a da reunião pedida.
     */
    async findSharedByJoinUrl(joinUrl, user, start = null) {
        const base = String(joinUrl || '').split('?')[0];
        if (!base) return [];

        const where = {
            join_url: { [db.Sequelize.Op.like]: `${base}%` },
            parsed_transcript: { [db.Sequelize.Op.ne]: null },
        };

        const inicio = start ? new Date(start).getTime() : NaN;
        if (Number.isFinite(inicio)) {
            where.meeting_date = {
                [db.Sequelize.Op.between]: [
                    new Date(inicio - 12 * 60 * 60_000),
                    new Date(inicio + 12 * 60 * 60_000),
                ],
            };
        }

        const linhas = await db.MeetingTranscript.findAll({
            where,
            include: [{ model: db.User, as: 'user', attributes: ['id', 'username'] }],
            order: [['created_at', 'ASC']],
        });

        return linhas.filter(l => l.user_id !== user.id && this.participou(l, user));
    }

    /**
     * Copia para o registro da pessoa o que outro participante já tem.
     * Não chama o Graph e não gasta token de IA: é o mesmo conteúdo.
     */
    async copiarDeCompartilhado(destino, origem, { comRelatorio = false } = {}) {
        const patch = {
            parsed_transcript:     origem.parsed_transcript,
            transcript_char_count: origem.transcript_char_count,
            status:                'transcribed',
            shared_from_id:        origem.id,
            shared_from_name:      origem.user?.username || origem.organizer_name || null,
        };

        if (comRelatorio && origem.report_json) {
            patch.report_json         = origem.report_json;
            patch.ai_model            = origem.ai_model;
            patch.report_generated_at = origem.report_generated_at;
            patch.tokens_used         = 0;   // não foi esta pessoa que pagou
            patch.status              = 'summarized';
        }

        // Metadados da reunião: quem chegou pelo caminho compartilhado costuma
        // ter menos do que quem organizou.
        for (const campo of ['subject', 'meeting_date', 'duration_min', 'join_url',
                             'web_link', 'organizer_name', 'organizer_email', 'attendees_json']) {
            if (destino[campo] == null && origem[campo] != null) patch[campo] = origem[campo];
        }

        await destino.update(patch);
        return destino;
    }
}

export default new MicrosoftTranscriptService();

// scheduler/microsoftMeetingReminderScheduler.js
//
// Aviso de reunião que funciona com o Office FECHADO.
//
// A Central Microsoft já avisava "começa em 15 min", mas só enquanto a aba
// estivesse aberta — ou seja, avisava quem já estava olhando. O catálogo tinha
// 491 tipos de notificação e nenhum de reunião, num app que é PWA com push
// nativo desde 19/08.
//
// Como funciona: a cada 5 minutos olha o calendário de quem tem conta Microsoft
// vinculada e dispara `meeting.starting` para as reuniões que começam dentro da
// janela. O canal escolhido é do usuário (preferências de notificação) — o
// padrão é in-app + push, sem e-mail, porque e-mail 10 minutos antes chega tarde.
//
// Idempotência: cada (usuário, evento, ocorrência) só é avisado uma vez. O
// controle é em memória, com limpeza por idade — reunião avisada é passado, e
// reiniciar o backend no meio do dia avisar de novo é bem menos ruim do que
// carregar uma tabela para isso.

import cron from 'node-cron';
import db from '../models/sequelize/index.js';
import teamsService from '../services/microsoft/MicrosoftTeamsService.js';
import settingsService from '../services/microsoft/MicrosoftSettingsService.js';
import NotificationService from '../services/notification/NotificationService.js';
import { NotificationType } from '../services/notification/notificationTypes.js';

// Quantos minutos antes avisar. Reunião que começa dentro desta janela entra.
const JANELA_MIN = 15;

// Roda a cada 5 min: com janela de 15, toda reunião cai em pelo menos uma
// passada, mesmo que uma falhe.
const CRON = '*/5 * * * *';

// Marcações de "já avisei". Chave: userId:eventId:inicioISO — o início entra na
// chave para série recorrente avisar em cada ocorrência, não só na primeira.
const avisados = new Map(); // chave → timestamp
const TTL_MS = 6 * 60 * 60 * 1000; // 6h é folga suficiente para qualquer fuso

function limpar() {
    const corte = Date.now() - TTL_MS;
    for (const [k, t] of avisados.entries()) if (t < corte) avisados.delete(k);
}

function horaLocal(iso) {
    // O service já devolve no fuso de Brasília (header Prefer).
    return String(iso || '').slice(11, 16);
}

async function rodar() {
    limpar();

    const settings = await settingsService.get().catch(() => ({}));
    if (settings.meeting_reminder_enabled === false) return;

    const janela = Number(settings.meeting_reminder_minutes) || JANELA_MIN;

    // Só quem tem sessão Microsoft utilizável. Sem refresh_token não há como
    // ler agenda, e tentar geraria erro a cada 5 minutos para sempre.
    const usuarios = await db.User.findAll({
        where: {
            status: true,
            microsoft_id: { [db.Sequelize.Op.ne]: null },
            microsoft_refresh_token: { [db.Sequelize.Op.ne]: null },
        },
        attributes: ['id', 'username', 'email', 'microsoft_id',
                     'microsoft_access_token', 'microsoft_refresh_token', 'microsoft_token_expires_at'],
    });

    if (!usuarios.length) return;

    const agora = Date.now();
    const fimJanela = new Date(agora + janela * 60_000);
    // Começa um pouco atrás para pegar reunião que acabou de começar e ninguém viu.
    const inicioJanela = new Date(agora - 2 * 60_000);

    let enviados = 0;
    let falhas = 0;

    for (const u of usuarios) {
        try {
            const { items } = await teamsService.getCalendarView(
                u, inicioJanela.toISOString(), fimJanela.toISOString()
            );

            for (const ev of items) {
                if (ev.isCancelled || ev.isAllDay) continue;
                // Recusado é compromisso que a pessoa disse que não vai.
                if (ev.responseStatus === 'declined') continue;

                const chave = `${u.id}:${ev.seriesMasterId || ev.id}:${ev.start}`;
                if (avisados.has(chave)) continue;

                const minutos = Math.max(0, Math.round((new Date(ev.start).getTime() - agora) / 60_000));

                await NotificationService.notify({
                    type: NotificationType.MEETING_STARTING,
                    recipients: { users: [u.id] },
                    title: minutos > 0
                        ? `Reunião em ${minutos} min: ${ev.subject}`
                        : `Reunião começando: ${ev.subject}`,
                    body: [
                        `${horaLocal(ev.start)} às ${horaLocal(ev.end)}`,
                        ev.location || null,
                        ev.attendees?.length ? `${ev.attendees.length} participante(s)` : null,
                    ].filter(Boolean).join(' · '),
                    data: {
                        eventId: ev.id,
                        subject: ev.subject,
                        startTime: horaLocal(ev.start),
                        joinUrl: ev.joinUrl || null,
                        minutesUntil: minutos,
                    },
                    // Cai na Agenda, onde a pessoa vê o evento e o botão de entrar.
                    link: '/microsoft/teams?tab=agenda',
                    importance: 9,
                });

                avisados.set(chave, Date.now());
                enviados++;
            }
        } catch (err) {
            falhas++;
            // Sessão Microsoft caída é o caso comum e não é incidente: o
            // getValidToken já zerou os tokens e o usuário sai da consulta na
            // próxima passada.
            const msg = err?.message || '';
            if (!/expirad|conectad/i.test(msg)) {
                console.warn(`⚠️  [MeetingReminder] user ${u.id}: ${msg}`);
            }
        }
    }

    if (enviados || falhas) {
        console.log(`🔔 [MeetingReminder] ${enviados} aviso(s), ${falhas} falha(s), ${usuarios.length} agenda(s) lida(s).`);
    }
}

const microsoftMeetingReminderScheduler = {
    start() {
        cron.schedule(CRON, () => {
            rodar().catch(err => console.error('❌ [MeetingReminder]', err.message));
        }, { timezone: process.env.TIMEZONE || 'America/Sao_Paulo' });

        console.log(`✅ Lembrete de reunião do Teams agendado: ${CRON} (janela de ${JANELA_MIN} min).`);
    },
    runNow: rodar,
};

export default microsoftMeetingReminderScheduler;

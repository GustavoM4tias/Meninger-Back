// scheduler/microsoftTranscriptWatcherScheduler.js
//
// A ata fica pronta sozinha, e a pessoa é avisada.
//
// Antes, depois da reunião acabar era tudo puxado: abrir a tela, achar a
// reunião na lista, mandar procurar a transcrição, carregar o conteúdo e só
// então pedir o relatório. Quatro passos manuais - e quase sempre o primeiro
// falhava, porque o Teams ainda estava processando. Quem GRAVA a reunião sente
// isso o tempo todo: o vídeo entra na fila junto e a transcrição demora mais
// para aparecer na API. A pessoa clicava, via "sem transcrição" e desistia.
//
// Este vigia repete a busca enquanto a reunião for recente. Quando acha, baixa,
// gera o relatório e espelha para os outros participantes que têm conta no
// Office - todos com a mesma ata, gerada UMA vez. Aí avisa: "a ata da reunião X
// está pronta".
//
// Efeito colateral que é metade do valor: quando alguém abre a tela ou pergunta
// à Eme "o que ficou decidido na reunião de ontem", a resposta já está lá.

import cron from 'node-cron';
import db from '../models/sequelize/index.js';
import teamsService from '../services/microsoft/MicrosoftTeamsService.js';
import transcriptService from '../services/microsoft/MicrosoftTranscriptService.js';
import settingsService from '../services/microsoft/MicrosoftSettingsService.js';
import NotificationService from '../services/notification/NotificationService.js';
import { NotificationType } from '../services/notification/notificationTypes.js';

// A cada 10 minutos. A transcrição do Teams costuma levar de poucos minutos a
// meia hora depois do fim; com gravação, mais.
const CRON = '*/10 * * * *';

// Quanto tempo continuar tentando depois do fim da reunião. Passou disso, o
// Teams não vai mais gerar - ou a transcrição nunca foi ligada.
const HORAS_JANELA_PADRAO = 48;

// Reunião muito curta quase sempre é engano de agenda ou "só entrei para ver".
const MIN_MINUTOS = 5;

// Backoff por reunião: sem isso, uma reunião sem transcrição seria consultada a
// cada 10 minutos por dois dias, para nada. Chave: joinUrl base + dia da
// ocorrência - série recorrente repete o joinUrl toda semana, e com a chave só
// pelo link as falhas de ontem esgotavam as tentativas da reunião de hoje.
const tentativas = new Map();   // chave → { n, ultima }
const MAX_TENTATIVAS = 12;

function chaveDe(joinUrl, start) {
    return String(joinUrl || '').split('?')[0]
         + '|' + String(start || '').slice(0, 10);
}

function podeTentar(chave) {
    const t = tentativas.get(chave);
    if (!t) return true;
    if (t.n >= MAX_TENTATIVAS) return false;
    // Espaça: 10 min, 20, 40, 80... até o teto de 4 horas.
    const espera = Math.min(10 * 60_000 * 2 ** (t.n - 1), 4 * 60 * 60_000);
    return Date.now() - t.ultima >= espera;
}

function registrarTentativa(chave) {
    const t = tentativas.get(chave) || { n: 0, ultima: 0 };
    tentativas.set(chave, { n: t.n + 1, ultima: Date.now() });
}

function limparAntigas() {
    const corte = Date.now() - 3 * 24 * 60 * 60_000;
    for (const [k, t] of tentativas.entries()) if (t.ultima < corte) tentativas.delete(k);
}

/** Já existe ata DESTA OCORRÊNCIA no banco? (de qualquer pessoa)
 *  O recorte por data é o que faz série recorrente funcionar: o joinUrl é o
 *  mesmo toda semana, e sem ele a ata da primeira ocorrência fazia o vigia
 *  pular todas as seguintes para sempre. */
async function jaTemAta(joinUrl, start) {
    const base = String(joinUrl || '').split('?')[0];
    if (!base) return null;

    const where = {
        join_url: { [db.Sequelize.Op.like]: `${base}%` },
        report_json: { [db.Sequelize.Op.ne]: null },
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

    return db.MeetingTranscript.findOne({
        where,
        order: [['report_generated_at', 'ASC']],
    });
}

function dataLegivel(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
         + ' às ' + String(iso).slice(11, 16);
}

async function avisar(userIds, record) {
    if (!userIds.length) return;

    const r = record.report_json || {};
    const decisoes = (r.decisoes || []).length;
    const acoes    = (r.acoes || []).length;

    await NotificationService.notify({
        type: NotificationType.MEETING_REPORT_READY,
        recipients: { users: userIds },
        title: `Ata pronta: ${record.subject || 'reunião'}`,
        body: [
            record.meeting_date ? dataLegivel(record.meeting_date.toISOString?.() || record.meeting_date) : null,
            decisoes ? `${decisoes} decisão(ões)` : null,
            acoes ? `${acoes} ação(ões)` : null,
        ].filter(Boolean).join(' · ') || 'Resumo, decisões e ações da reunião.',
        data: {
            transcriptId: record.transcript_id,
            subject: record.subject,
            decisoes,
            acoes,
        },
        link: '/microsoft/teams?tab=reunioes&sub=reports',
        importance: 6,
    });
}

async function rodar() {
    limparAntigas();

    const settings = await settingsService.get().catch(() => ({}));
    if (settings.transcript_auto_report === false) return;

    const horas = Number(settings.transcript_watch_hours) || HORAS_JANELA_PADRAO;

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
    let prontas = 0, avisos = 0, semTranscricao = 0, falhas = 0;

    for (const u of usuarios) {
        try {
            const reunioes = await transcriptService.getRecentTeamsMeetings(u, Math.ceil(horas / 24) + 1);

            for (const r of reunioes) {
                if (!r.joinUrl || !r.end) continue;

                const fim = new Date(r.end).getTime();
                const minutos = r.start ? Math.round((fim - new Date(r.start).getTime()) / 60000) : 0;

                // Ainda acontecendo, velha demais ou curta demais.
                if (fim > agora - 60_000) continue;
                if (fim < agora - horas * 60 * 60_000) continue;
                if (minutos && minutos < MIN_MINUTOS) continue;

                const chave = chaveDe(r.joinUrl, r.start);

                // Outra pessoa já gerou: espelha para esta e segue - sem Graph,
                // sem IA. É o caso mais comum numa reunião de time.
                const existente = await jaTemAta(r.joinUrl, r.start);
                if (existente) {
                    // Convite sem lista de participantes (canal/lista de
                    // distribuição) deixava a ata órfã: completa a lista com o
                    // que o calendário DESTA pessoa sabe.
                    if (!(existente.attendees_json || []).length && (r.attendees || []).length) {
                        await existente.update({ attendees_json: r.attendees });
                    }
                    // A reunião estar no calendário de u já prova participação:
                    // u ganha a cópia mesmo quando a lista do evento é vazia.
                    const novos = await transcriptService.espelharParaParticipantes(existente, [u.id]);
                    if (novos.length) { await avisar(novos, existente); avisos += novos.length; }
                    continue;
                }

                if (!podeTentar(chave)) continue;
                registrarTentativa(chave);

                const { estado, record } = await transcriptService.garantirAta(u, r);

                if (estado !== 'pronto') { semTranscricao++; continue; }

                prontas++;
                tentativas.delete(chave);

                const outros = await transcriptService.espelharParaParticipantes(record);
                const todos = [u.id, ...outros];
                await avisar(todos, record);
                avisos += todos.length;
            }
        } catch (err) {
            falhas++;
            const msg = err?.message || '';
            // Sessão caída é rotina, não incidente: o getValidToken já zerou os
            // tokens e a pessoa sai da consulta na próxima passada.
            if (!/expirad|conectad/i.test(msg)) {
                console.warn(`⚠️  [TranscriptWatcher] user ${u.id}: ${msg}`);
            }
        }
    }

    if (prontas || avisos || falhas) {
        console.log(`📝 [TranscriptWatcher] ${prontas} ata(s) nova(s), ${avisos} aviso(s), `
                  + `${semTranscricao} sem transcrição ainda, ${falhas} falha(s).`);
    }
}

const microsoftTranscriptWatcherScheduler = {
    start() {
        cron.schedule(CRON, () => {
            rodar().catch(err => console.error('❌ [TranscriptWatcher]', err.message));
        }, { timezone: process.env.TIMEZONE || 'America/Sao_Paulo' });

        console.log(`✅ Vigia de transcrição do Teams agendado: ${CRON} (janela de ${HORAS_JANELA_PADRAO}h).`);
    },
    runNow: rodar,
};

export default microsoftTranscriptWatcherScheduler;

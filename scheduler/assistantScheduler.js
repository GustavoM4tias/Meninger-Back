// scheduler/assistantScheduler.js
//
// O que faz o assistente existir quando o Office está fechado.
//
// Três rotinas, e cada uma tem um motivo próprio para a hora em que roda:
//
//   RESUMO DO DIA   de hora em hora, e manda para quem escolheu ESTA hora. Não
//                   é um disparo às 8h para todo mundo: quem entra às 7h quer
//                   às 7h, e um horário fixo faria metade da empresa receber o
//                   resumo depois de já ter aberto o e-mail.
//
//   PRAZO CHEGANDO  três vezes ao dia. Prazo que vence hoje precisa ser dito
//                   hoje, e de manhã já foi - mas avisar de hora em hora vira
//                   ruído e a pessoa desliga o canal.
//
//   COISA PARADA    uma vez ao dia, no fim da tarde. É cobrança de coisa
//                   antiga: se fosse urgente, teria vindo pelo prazo.
//
// A MARCA DE "JÁ AVISEI" É DE BANCO, não de memória. O lembrete de reunião pode
// se dar ao luxo de esquecer num restart; o resumo do dia não - um deploy às
// 8h05 mandaria o segundo resumo para a empresa inteira.

import cron from 'node-cron';
import { Op } from 'sequelize';
import db from '../models/sequelize/index.js';
import assistente, { calcularLembretes, comoFalta } from '../services/assistant/PersonalAssistantService.js';
import parceria from '../services/collab/ParceriaService.js';
import NotificationService from '../services/notification/NotificationService.js';
import { NotificationType } from '../services/notification/notificationTypes.js';

const TZ = 'America/Sao_Paulo';

function hojeLocal() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}
function diaStr(d = hojeLocal()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Quem tem o assistente ligado. Sem linha de config, ninguém é incomodado. */
async function comAssistente() {
    return db.AssistantSettings.findAll({
        where: { ativo: true },
        include: [{ model: db.User, as: 'user', required: true, attributes: ['id', 'username', 'email'] }],
        limit: 500,
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Resumo do dia
// ═══════════════════════════════════════════════════════════════════════════

let rodandoResumo = false;

async function resumoDoDia() {
    if (rodandoResumo) return;
    rodandoResumo = true;

    try {
        const agora = hojeLocal();
        const hora = agora.getHours();
        const dia = diaStr(agora);

        // Fim de semana não recebe resumo de trabalho.
        if (agora.getDay() === 0 || agora.getDay() === 6) return;

        const linhas = (await comAssistente()).filter(l => l.resumo_diario && l.resumo_hora === hora);
        if (!linhas.length) return;

        let enviados = 0;
        for (const l of linhas) {
            try {
                // A marca vem ANTES de montar o dia: montar custa chamadas ao
                // Graph, e se duas instâncias subirem juntas as duas pagariam.
                const primeiro = await assistente.marcarAviso(l.user_id, 'resumo', dia);
                if (!primeiro) continue;

                const dia_ = await assistente.meuDia(l.user_id);

                // Dia sem nada não vira notificação: avisar "você não tem nada"
                // é gastar a atenção da pessoa para não dizer nada.
                if (!dia_.numeros.pendencias && !dia_.numeros.compromissos) continue;

                await NotificationService.notify({
                    type: NotificationType.ASSISTANT_DAILY,
                    recipients: { users: [l.user_id] },
                    title: 'Seu dia no Office',
                    body: dia_.resumo,
                    link: '/assistente',
                    importance: 4,
                    data: { numeros: dia_.numeros },
                    channels: { inapp: true, email: !!l.por_email, whatsapp: false },
                });
                enviados++;
            } catch (err) {
                console.warn(`⚠️  [Assistente] resumo do user ${l.user_id}:`, err.message);
            }
        }

        if (enviados) console.log(`🗓️  [Assistente] resumo do dia enviado para ${enviados} pessoa(s) (${hora}h).`);
    } catch (err) {
        console.error('❌ [Assistente] resumo falhou:', err.message);
    } finally {
        rodandoResumo = false;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Prazo chegando
// ═══════════════════════════════════════════════════════════════════════════

let rodandoPrazo = false;

/**
 * Avisa o que pediu para ser avisado AGORA.
 *
 * ANTES ISTO ERA UM VARREDOR DE 36 HORAS que rodava 3x ao dia, e por isso
 * "me lembra 1h antes das 16h" chegava às 9h07 ou às 13h07 - nunca às 15h. O
 * lembrete só vale se cair na hora pedida, então a passada é de 10 em 10
 * minutos e o corte é `lembrar_em <= agora`: quem manda é a hora gravada na
 * tarefa, não a hora do cron.
 *
 * Uma tarefa pode ter VÁRIOS avisos (2 dias antes E 1 hora antes). Cada
 * disparo marca só os que venceram e recalcula o próximo; `lembrete_enviado_em`
 * só é preenchido quando não sobrou nenhum - é ele que tira a tarefa da
 * varredura de vez.
 */
async function prazosChegando() {
    if (rodandoPrazo) return;
    rodandoPrazo = true;

    try {
        const linhas = (await comAssistente()).filter(l => l.alerta_prazo);
        if (!linhas.length) return;

        const agora = new Date();
        let avisados = 0;

        for (const l of linhas) {
            try {
                const tarefas = await db.AssistantTask.findAll({
                    where: {
                        user_id: l.user_id,
                        estado: 'aberta',
                        lembrar_em: { [Op.ne]: null, [Op.lte]: agora },
                        lembrete_enviado_em: null,
                    },
                    limit: 20,
                });
                if (!tarefas.length) continue;

                const atrasadas = tarefas.filter(t => t.prazo && new Date(t.prazo) < agora);
                const titulo = tarefas.length === 1
                    ? tituloDeUma(tarefas[0], agora)
                    : (atrasadas.length
                        ? `${atrasadas.length} de ${tarefas.length} tarefas passaram do prazo`
                        : `${tarefas.length} tarefas pedem sua atenção`);

                const corpo = tarefas.slice(0, 5).map(t => `· ${t.titulo} (${quandoVence(t, agora)})`).join('\n');

                // ── Qual template do WhatsApp ────────────────────────────
                //
                // "está chegando" e "já venceu" são mensagens diferentes, e o
                // WhatsApp exige template fixo por tipo. Então o TIPO é que
                // escolhe: se o que motivou o aviso já passou do prazo, é
                // cobrança; senão, é lembrete.
                const venceu = atrasadas.length > 0;
                const primeira = (venceu ? atrasadas : tarefas)[0];

                await NotificationService.notify({
                    type: venceu ? NotificationType.ASSISTANT_OVERDUE : NotificationType.ASSISTANT_DEADLINE,
                    recipients: { users: [l.user_id] },
                    title: titulo,
                    body: corpo,
                    link: '/assistente',
                    importance: venceu ? 2 : 3,
                    // WhatsApp é opt-in por pessoa (nasce desligado no catálogo).
                    // Aqui o canal é liberado; quem decide é a preferência dela.
                    channels: { inapp: true, email: !!l.por_email, whatsapp: true },
                    // As 4 variáveis do template, na ordem. A terceira é o
                    // contexto - o template a chama de "checklist".
                    whatsappData: {
                        tarefa: primeira?.titulo || 'sua tarefa',
                        contexto: tarefas.length > 1 ? `Suas tarefas (+${tarefas.length - 1})` : 'Suas tarefas',
                        prazo: quandoVence(primeira, agora),
                    },
                });

                // Marca DEPOIS de avisar: se o envio falhar, a próxima passada
                // tenta de novo em vez de a tarefa ficar silenciosa para sempre.
                for (const t of tarefas) await marcarAvisoDado(t, agora);
                avisados++;
            } catch (err) {
                console.warn(`⚠️  [Assistente] prazo do user ${l.user_id}:`, err.message);
            }
        }

        if (avisados) console.log(`⏰ [Assistente] aviso de prazo para ${avisados} pessoa(s).`);
    } catch (err) {
        console.error('❌ [Assistente] prazos falharam:', err.message);
    } finally {
        rodandoPrazo = false;
    }
}

/** "Falta 1 hora para: lançar o Alelo" - o aviso diz o que falta, não "atenção". */
function tituloDeUma(t, agora) {
    if (!t.prazo) return t.titulo;
    const min = Math.round((new Date(t.prazo).getTime() - agora.getTime()) / 60000);
    if (min < 0) return `Passou do prazo: ${t.titulo}`;
    if (min < 5) return `É agora: ${t.titulo}`;
    return `${comoFalta(min)[0].toUpperCase()}${comoFalta(min).slice(1)} para: ${t.titulo}`;
}

function quandoVence(t, agora) {
    if (!t.prazo) return 'sem data';
    const p = new Date(t.prazo);
    const hoje = p.toDateString() === agora.toDateString();
    const hora = p.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
    return hoje ? `hoje ${hora}` : `${p.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${hora}`;
}

/** Risca os avisos vencidos e agenda o próximo, se houver. */
async function marcarAvisoDado(t, agora) {
    const avisos = Array.isArray(t.avisos) ? t.avisos : [];

    if (!avisos.length) {
        // Tarefa do desenho antigo: um lembrete só, e acabou.
        await t.update({ lembrete_enviado_em: agora });
        return;
    }

    const base = t.prazo ? new Date(t.prazo).getTime() : agora.getTime();
    const jaForam = new Set((t.avisos_enviados || []).map(Number));
    for (const m of avisos) {
        if (base - m * 60000 <= agora.getTime()) jaForam.add(m);
    }

    const calc = calcularLembretes(t.prazo, avisos, [...jaForam]);
    await t.update({
        avisos_enviados: calc.enviados,
        lembrar_em: calc.lembrarEm,
        // Só encerra quando não sobrou aviso: senão o segundo nunca sairia.
        lembrete_enviado_em: calc.lembrarEm ? null : agora,
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Acompanhamento: a tarefa que depende de outra pessoa
// ═══════════════════════════════════════════════════════════════════════════
//
// "Cobrar o Lúcio" não termina quando o prazo chega: termina quando o Lúcio
// responde. Marcada para acompanhar, a tarefa volta a aparecer de N em N dias
// enquanto estiver aberta - e é o único alerta do assistente que funciona SEM
// prazo, porque justamente não se sabe a data.

async function acompanhamentos() {
    try {
        const linhas = await comAssistente();
        const porUsuario = new Map(linhas.map(l => [l.user_id, l]));
        if (!porUsuario.size) return;

        const abertas = await db.AssistantTask.findAll({
            where: {
                estado: 'aberta',
                acompanhar: true,
                user_id: { [Op.in]: [...porUsuario.keys()] },
            },
            limit: 400,
        });

        const agora = Date.now();
        const porPessoa = new Map();

        for (const t of abertas) {
            const cada = Math.max(Number(t.acompanhar_cada) || 2, 1);
            // O relógio conta da última cutucada, ou da criação se nunca houve.
            // `createdAt`, não `created_at` - com o nome errado a data vem
            // undefined, a conta vira NaN e a comparação passa, cutucando todo
            // dia. Data inválida aqui é "recém-criada", nunca "já passou".
            const desde = new Date(t.acompanhado_em || t.createdAt).getTime();
            if (!Number.isFinite(desde)) continue;
            if ((agora - desde) / 86400000 < cada) continue;
            if (!porPessoa.has(t.user_id)) porPessoa.set(t.user_id, []);
            porPessoa.get(t.user_id).push(t);
        }

        let avisados = 0;
        for (const [userId, tarefas] of porPessoa) {
            try {
                await NotificationService.notify({
                    type: NotificationType.ASSISTANT_STALLED,
                    recipients: { users: [userId] },
                    title: tarefas.length === 1
                        ? `Como está: ${tarefas[0].titulo}?`
                        : `${tarefas.length} coisas que você pediu para acompanhar`,
                    body: tarefas.slice(0, 5).map(t => `· ${t.titulo}`).join('\n'),
                    link: '/assistente',
                    importance: 4,
                    channels: { inapp: true, email: false, whatsapp: false },
                });
                await db.AssistantTask.update(
                    { acompanhado_em: new Date() },
                    { where: { id: { [Op.in]: tarefas.map(t => t.id) } } },
                );
                avisados++;
            } catch (err) {
                console.warn(`⚠️  [Assistente] acompanhamento do user ${userId}:`, err.message);
            }
        }

        if (avisados) console.log(`🔁 [Assistente] acompanhamento para ${avisados} pessoa(s).`);
    } catch (err) {
        console.error('❌ [Assistente] acompanhamento falhou:', err.message);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Convites de parceria sem resposta
// ═══════════════════════════════════════════════════════════════════════════
//
// Ignorar não é resposta: enquanto o convite estiver pendente, ele volta - SEM
// número máximo de cobranças. O espaçamento cresce até um piso de 3 dias e fica
// nele para sempre. Quem encerra é a resposta, ou o mundo: a mesma passada
// pergunta ao módulo se a tarefa ainda existe e se o prazo já passou, e caduca
// o convite que perdeu o sentido. Ver ParceriaService.

async function convitesParados() {
    try {
        const { cobrados, caducados } = await parceria.cobrarPendentes();
        if (cobrados || caducados) {
            console.log(`🤝 [Parceria] ${cobrados} convite(s) cobrado(s), ${caducados} caducado(s).`);
        }
    } catch (err) {
        console.error('❌ [Parceria] cobrança falhou:', err.message);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Sincronizar com o e-mail: criar o que nasceu, fechar o que morreu
// ═══════════════════════════════════════════════════════════════════════════

let rodandoSync = false;

async function sincronizar() {
    if (rodandoSync) return;
    rodandoSync = true;

    try {
        const linhas = await comAssistente();
        let criadas = 0;
        let fechadas = 0;

        for (const l of linhas) {
            try {
                criadas += await assistente.tarefasDeEmail(l.user_id);
                // Fechar vem depois de criar, de propósito: um e-mail resolvido
                // na mesma passada em que virou tarefa nasce e morre junto, em
                // vez de ficar aberto até amanhã.
                fechadas += await assistente.fecharTarefasResolvidas(l.user_id);
            } catch (err) {
                console.warn(`⚠️  [Assistente] sync do user ${l.user_id}:`, err.message);
            }
        }

        if (criadas || fechadas) {
            console.log(`🔗 [Assistente] ${criadas} tarefa(s) criada(s) de e-mail, ${fechadas} fechada(s) por já resolvidas.`);
        }
    } catch (err) {
        console.error('❌ [Assistente] sincronização falhou:', err.message);
    } finally {
        rodandoSync = false;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Coisa parada
// ═══════════════════════════════════════════════════════════════════════════

async function coisaParada() {
    try {
        const linhas = (await comAssistente()).filter(l => l.alerta_parado);
        const dia = diaStr();
        let avisados = 0;

        for (const l of linhas) {
            try {
                const d = await assistente.meuDia(l.user_id);
                const paradas = d.pendencias.filter(p => ['cobranca', 'aprovacao'].includes(p.tipo));
                if (!paradas.length) continue;

                // Uma vez por dia por pessoa.
                if (!await assistente.marcarAviso(l.user_id, 'parado', dia)) continue;

                await NotificationService.notify({
                    type: NotificationType.ASSISTANT_STALLED,
                    recipients: { users: [l.user_id] },
                    title: `${paradas.length} coisa(s) esperando você faz dias`,
                    body: paradas.slice(0, 5).map(p => `· ${p.titulo}`).join('\n'),
                    link: '/assistente',
                    importance: 5,
                    channels: { inapp: true, email: false, whatsapp: false },
                });
                avisados++;
            } catch (err) {
                console.warn(`⚠️  [Assistente] parado do user ${l.user_id}:`, err.message);
            }
        }

        if (avisados) console.log(`🐢 [Assistente] aviso de coisa parada para ${avisados} pessoa(s).`);

        // Aproveita a passada mais rara do dia para limpar as marcas velhas.
        await assistente.limparAvisos({ dias: 45 });
    } catch (err) {
        console.error('❌ [Assistente] coisa parada falhou:', err.message);
    }
}

export default {
    start() {
        // De hora em hora, aos 2 minutos: cada pessoa recebe na hora que
        // escolheu. Minuto 2 e não 0 - a virada da hora é onde todo cron do
        // mundo se acumula.
        cron.schedule('2 * * * *', resumoDoDia, { timezone: TZ });

        // De 10 em 10 minutos, das 6h às 22h, TODO DIA. Precisa ser fino porque
        // é a pessoa que escolhe a hora: "1h antes das 16h" tem que sair às 15h,
        // não na próxima janela de três em três horas. Inclui fim de semana -
        // prazo pessoal não sabe que é sábado.
        cron.schedule('*/10 6-22 * * *', prazosChegando, { timezone: TZ });

        // De 20 em 20 minutos em horário de trabalho: mantém a lista viva sem
        // esperar a pessoa abrir a tela.
        cron.schedule('*/20 7-20 * * 1-5', sincronizar, { timezone: TZ });

        // 17h40: cobrança do que está parado, antes de a pessoa sair.
        cron.schedule('40 17 * * 1-5', coisaParada, { timezone: TZ });

        // 9h20: o que a pessoa pediu para acompanhar. De manhã, porque cobrar
        // alguém é coisa que se faz durante o dia, não ao sair.
        cron.schedule('20 9 * * 1-5', acompanhamentos, { timezone: TZ });

        // 9h50 e 16h20: convite sem resposta volta a aparecer, e o que perdeu o
        // sentido caduca. Duas passadas porque a segunda é a que pega o prazo
        // que venceu durante o dia - esperar até a manhã seguinte para dizer
        // "não precisa mais" deixa a pessoa uma tarde inteira devendo resposta
        // sobre algo que já morreu.
        cron.schedule('50 9,16 * * 1-5', convitesParados, { timezone: TZ });

        console.log('🧭 [Assistente] rotinas agendadas (resumo na hora escolhida, lembretes 10min, sync 20min, parados 17h40, acompanhamento 9h20, convites 9h50 e 16h50).');
    },
    resumoDoDia,
    prazosChegando,
    sincronizar,
    coisaParada,
    acompanhamentos,
    convitesParados,
};

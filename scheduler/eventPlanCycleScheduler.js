// scheduler/eventPlanCycleScheduler.js
//
// Ciclo mensal do Plano de Eventos. Roda uma vez por dia e faz duas coisas:
//
//  1. ABERTURA — a partir de `open_days_before_month_end` dias antes do fim do
//     mês (padrão 7 = última semana), cria o plano em rascunho do MÊS SEGUINTE
//     para cada empreendimento elegível e avisa o gestor responsável.
//  2. COBRANÇA — enquanto o plano do mês vigente não for enviado, lembra o
//     gestor nos offsets configurados (padrão D-5, D-2 e no dia do prazo).
//
// Empreendimento elegível = tem Ficha Comercial cuja versão mais recente NÃO
// está encerrada. `closed` na ficha significa "empreendimento finalizado, não
// evolui mais" — não faz sentido pedir plano de eventos para ele.
//
// Idempotente em tudo: plano já existente é pulado, e a cobrança do dia é
// registrada em event_plan_activities (dedupe por dia, mesmo padrão do
// checklistChaseScheduler). Serializado entre instâncias por advisory lock.

import cron from 'node-cron';
import db from '../models/sequelize/index.js';
import { PLAN_STATUS } from '../models/sequelize/eventPlan/eventPlan.js';
import { ACTIVITY } from '../models/sequelize/eventPlan/eventPlanActivity.js';
import { getSettings, getStages, logActivity, submitPlanCore } from '../services/eventPlan/eventPlanService.js';
import { resolveOwnersForEnterprise } from '../services/eventPlan/eventPlanOwnerService.js';
import NotificationService from '../services/notification/NotificationService.js';
import { NotificationType } from '../services/notification/notificationTypes.js';

const { EventPlan, EventPlanActivity, EventPlanAuthProfile, CvEnterprise, sequelize } = db;

const CYCLE_CRON = process.env.EVENT_PLAN_CYCLE_CRON || '0 8 * * *';
const TIMEZONE = process.env.EVENT_PLAN_TZ || 'America/Sao_Paulo';
const LOCK_KEY = 884413; // vizinho do lock da auto-geração de fichas (884412)

// ─── Datas no fuso configurado (o servidor roda em UTC no Railway) ───────────

function todayParts() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const [year, month, day] = parts.split('-').map(Number);
    return { year, month, day, iso: parts };
}

function daysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
}

function monthRef(year, month) {
    return `${year}-${String(month).padStart(2, '0')}-01`;
}

function nextMonthRef(year, month) {
    return month === 12 ? monthRef(year + 1, 1) : monthRef(year, month + 1);
}

function monthLabel(reference) {
    const names = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
        'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
    const [year, month] = String(reference).split('-');
    return `${names[Number(month) - 1] || month}/${year}`;
}

// ─── Regras do ciclo (puras — testáveis sem banco) ───────────────────────────

// A JANELA do plano de M+1 é a última semana de M: abre em
// (último dia - open_days_before_month_end + 1) e FECHA no último dia de M.
// Quem quiser adiantar envia a qualquer momento dentro dela; quem não enviar
// tem o plano mandado sozinho para aprovação quando ela fecha.

/** Primeiro dia da janela dentro do mês corrente. */
export function windowStartDay(settings, today) {
    return daysInMonth(today.year, today.month) - Number(settings.open_days_before_month_end || 7) + 1;
}

/**
 * Hoje é dia de ABRIR o plano do mês seguinte? Vale para todos os dias da
 * janela, não só o primeiro — assim empreendimento cadastrado no dia 29 também
 * ganha plano.
 */
export function shouldOpen(settings, today) {
    return today.day >= windowStartDay(settings, today);
}

/**
 * Hoje é o último dia do mês, ou seja, o dia em que a janela FECHA e o envio
 * automático acontece.
 */
export function isWindowClosingDay(today) {
    return today.day === daysInMonth(today.year, today.month);
}

/**
 * Hoje é dia de COBRAR? Os offsets contam a partir do FECHAMENTO DA JANELA (o
 * último dia do mês). Fora da janela não se cobra nada: não faz sentido lembrar
 * de um plano que ainda nem abriu.
 */
export function shouldChase(settings, today) {
    if (!settings.chase_enabled) return { chase: false, daysToDeadline: null, late: false };
    if (!shouldOpen(settings, today)) return { chase: false, daysToDeadline: null, late: false };

    const daysToDeadline = daysInMonth(today.year, today.month) - today.day;
    const offsets = (settings.chase_offsets || [5, 2, 0]).map(Number);
    // Não existe "atrasado" na nova regra: no dia do fechamento o plano é
    // enviado automaticamente, então nunca sobra plano vencido para cobrar.
    return { chase: offsets.includes(daysToDeadline), daysToDeadline, late: false };
}

// ─── Elegibilidade ───────────────────────────────────────────────────────────

/**
 * Empreendimentos que devem ter plano: os que têm ficha comercial e cuja ficha
 * mais recente não está encerrada.
 */
async function eligibleEnterprises() {
    const rows = await sequelize.query(
        `SELECT DISTINCT ON (c.idempreendimento) c.idempreendimento, c.status
           FROM enterprise_conditions c
          WHERE c.idempreendimento IS NOT NULL
          ORDER BY c.idempreendimento, c.reference_month DESC, c.id DESC`,
        { type: db.Sequelize.QueryTypes.SELECT }
    );
    return rows.filter(r => r.status !== 'closed').map(r => Number(r.idempreendimento));
}

// ─── Abertura do ciclo ───────────────────────────────────────────────────────

async function openNextMonthPlans(settings, today) {
    if (!shouldOpen(settings, today)) return { opened: 0, skipped: 0 };

    const reference = nextMonthRef(today.year, today.month);
    const enterprises = await eligibleEnterprises();
    if (!enterprises.length) return { opened: 0, skipped: 0 };

    const existing = await EventPlan.findAll({
        where: { reference_month: reference, idempreendimento: enterprises },
        attributes: ['idempreendimento'],
    });
    const already = new Set(existing.map(p => Number(p.idempreendimento)));

    let opened = 0;
    for (const idempreendimento of enterprises) {
        if (already.has(idempreendimento)) continue;

        const resolved = await resolveOwnersForEnterprise(idempreendimento);
        // Abertura automática usa SÓ os gestores da ficha (diferente da criação
        // manual, que inclui quem abriu). Sem gestor, o plano nasce como
        // pendência visível em vez de não existir.
        const plan = await EventPlan.create({
            idempreendimento,
            reference_month: reference,
            owner_user_ids: resolved.userIds,
            owner_source: 'ficha',
            owner_unresolved: resolved.unresolved,
            status: PLAN_STATUS.DRAFT,
            totals: { proposed: 0, approved: 0, events_proposed: 0, events_approved: 0, events_rejected: 0 },
        });

        await logActivity({
            planId: plan.id, userId: null, action: ACTIVITY.PLAN_CREATED,
            meta: { reference_month: reference, auto: true, owners_from_ficha: resolved.userIds },
        });

        if (resolved.userIds.length) {
            const enterprise = await CvEnterprise.findByPk(idempreendimento, { attributes: ['nome'] });
            const fecha = `${daysInMonth(today.year, today.month)}/${String(today.month).padStart(2, '0')}`;
            await notifySafe({
                type: NotificationType.EVENT_PLAN_OPENED,
                recipients: { users: resolved.userIds },
                title: `Plano de eventos de ${monthLabel(reference)} aberto`,
                body: `${enterprise?.nome || 'Empreendimento'} · monte a proposta de eventos. A janela fecha em ${fecha}; `
                    + 'você pode enviar antes disso, e o que não for enviado vai automaticamente para aprovação no fechamento.',
                data: { planId: plan.id, referenceMonth: reference },
                link: `/comercial/plano-eventos/${plan.id}`,
                importance: 8,
                // Abertura de janela é o gatilho da rotina do gestor: garante o
                // e-mail mesmo que ele tenha desligado o canal.
                channels: { inapp: true, email: true, whatsapp: false },
                bypassPrefs: true,
            });
        }
        opened += 1;
    }

    return { opened, skipped: already.size };
}

// ─── Cobrança ────────────────────────────────────────────────────────────────

async function chasePendingPlans(settings, today) {
    const { chase, daysToDeadline } = shouldChase(settings, today);
    if (!chase) return { chased: 0 };

    // A janela aberta agora é a do mês SEGUINTE — é esse plano que se cobra.
    const reference = nextMonthRef(today.year, today.month);
    const pending = await EventPlan.findAll({
        where: {
            reference_month: reference,
            status: [PLAN_STATUS.DRAFT, PLAN_STATUS.RETURNED],
        },
    });

    let chased = 0;
    for (const plan of pending) {
        const owners = (plan.owner_user_ids || []).map(Number).filter(Boolean);
        if (!owners.length) continue; // sem dono não há a quem cobrar

        // Dedupe: um lembrete por plano por dia, mesmo se o scheduler rodar duas vezes.
        const sentToday = await EventPlanActivity.findOne({
            where: {
                plan_id: plan.id,
                action: ACTIVITY.CHASE_SENT,
                created_at: { [db.Sequelize.Op.gte]: new Date(`${today.iso}T00:00:00`) },
            },
        });
        if (sentToday) continue;

        const enterprise = await CvEnterprise.findByPk(plan.idempreendimento, { attributes: ['nome'] });
        const hoje = daysToDeadline === 0;
        await notifySafe({
            type: NotificationType.EVENT_PLAN_CHASE,
            recipients: { users: owners },
            title: hoje
                ? `Hoje fecha a janela do plano de ${monthLabel(reference)}`
                : `Faltam ${daysToDeadline} dia(s) para fechar o plano de ${monthLabel(reference)}`,
            body: `${enterprise?.nome || 'Empreendimento'} · o plano ainda está `
                + `${plan.status === PLAN_STATUS.RETURNED ? 'devolvido para ajuste' : 'em rascunho'}. `
                + (settings.auto_submit_enabled
                    ? 'No fechamento ele vai automaticamente para aprovação do jeito que estiver.'
                    : 'Envie antes do fechamento.'),
            data: { planId: plan.id },
            link: `/comercial/plano-eventos/${plan.id}`,
            importance: hoje ? 9 : 7,
        });

        await logActivity({
            planId: plan.id, userId: null, action: ACTIVITY.CHASE_SENT,
            meta: { days_to_deadline: daysToDeadline },
        });
        chased += 1;
    }

    return { chased };
}

// ─── Envio automático no fechamento da janela ────────────────────────────────

/**
 * Último dia do mês: todo plano do mês seguinte que ainda está em rascunho vai
 * SOZINHO para a validação do Comercial, do jeito que estiver. O mês nunca
 * começa sem proposta na mesa.
 *
 * Plano vazio é o caso que não pode passar calado: não há o que aprovar, então
 * ele fica em rascunho e o gestor (e quem valida) são avisados.
 */
async function autoSubmitClosingPlans(settings, today) {
    if (!settings.auto_submit_enabled) return { autoSubmitted: 0, empty: 0 };
    if (!isWindowClosingDay(today)) return { autoSubmitted: 0, empty: 0 };

    const reference = nextMonthRef(today.year, today.month);
    const pendentes = await EventPlan.findAll({
        where: { reference_month: reference, status: [PLAN_STATUS.DRAFT, PLAN_STATUS.RETURNED] },
    });

    let autoSubmitted = 0;
    let empty = 0;

    for (const plan of pendentes) {
        const owners = (plan.owner_user_ids || []).map(Number).filter(Boolean);
        const enterprise = await CvEnterprise.findByPk(plan.idempreendimento, { attributes: ['nome'] });
        const nome = enterprise?.nome || `Empreendimento ${plan.idempreendimento}`;

        const result = await submitPlanCore(plan, { userId: null, auto: true });

        if (!result.ok) {
            empty += 1;
            if (owners.length) {
                await notifySafe({
                    type: NotificationType.EVENT_PLAN_EMPTY,
                    recipients: { users: owners },
                    title: `Plano de ${monthLabel(reference)} fechou sem nenhum evento`,
                    body: `${nome} · a janela fechou e o plano estava vazio, então não houve o que enviar para aprovação. `
                        + 'Fale com o Comercial se ainda precisar propor algo para o mês.',
                    data: { planId: plan.id },
                    link: `/comercial/plano-eventos/${plan.id}`,
                    importance: 8,
                });
            }
            continue;
        }

        autoSubmitted += 1;
        if (owners.length) {
            await notifySafe({
                type: NotificationType.EVENT_PLAN_AUTO_SUBMITTED,
                recipients: { users: owners },
                title: `Plano de ${monthLabel(reference)} enviado automaticamente`,
                body: `${nome} · a janela fechou e o plano seguiu para a validação do Comercial com ${result.events} evento(s), `
                    + 'do jeito que estava. Se algo ficou faltando, peça a devolução para ajustar.',
                data: { planId: plan.id },
                link: `/comercial/plano-eventos/${plan.id}`,
                importance: 8,
            });
        }
        // Quem valida precisa saber que chegou fila nova.
        const validadores = await usersOfStage('COMERCIAL');
        if (validadores.length) {
            await notifySafe({
                type: NotificationType.EVENT_PLAN_SUBMITTED,
                recipients: { users: validadores },
                title: `Plano de eventos de ${nome} aguardando validação`,
                body: `${monthLabel(reference)} · ${result.events} evento(s), enviado automaticamente no fechamento da janela.`,
                data: { planId: plan.id },
                link: `/comercial/plano-eventos/${plan.id}`,
                importance: 7,
            });
        }
    }

    return { autoSubmitted, empty };
}

/** Usuários que decidem numa etapa (união dos perfis configurados). */
async function usersOfStage(stageKey) {
    const stages = await getStages();
    const stage = stages.find(s => s.key === stageKey);
    const profileIds = (stage?.profile_ids || []).map(Number).filter(Boolean);
    if (!profileIds.length) return [];
    const profiles = await EventPlanAuthProfile.findAll({
        where: { id: profileIds, is_active: true },
        attributes: ['user_ids'],
    });
    return [...new Set(profiles.flatMap(p => (p.user_ids || []).map(Number)).filter(Boolean))];
}

async function notifySafe(payload) {
    try {
        await NotificationService.notify(payload);
    } catch (e) {
        console.error('[EventPlanCycle] notificação falhou:', payload?.type, e?.message);
    }
}

// ─── Execução ────────────────────────────────────────────────────────────────

async function runCycle() {
    const settings = await getSettings();
    const today = todayParts();

    const opened = await openNextMonthPlans(settings, today);
    const chased = await chasePendingPlans(settings, today);
    // Por último: no dia do fechamento, quem não enviou vai automático. Roda
    // depois da cobrança para não mandar lembrete e envio no mesmo minuto.
    const auto = await autoSubmitClosingPlans(settings, today);

    if (opened.opened || chased.chased || auto.autoSubmitted || auto.empty) {
        console.log(`📅 [EventPlanCycle] ${opened.opened} aberto(s), ${chased.chased} cobrança(s), `
            + `${auto.autoSubmitted} enviado(s) automaticamente, ${auto.empty} vazio(s).`);
    }
    return { ...opened, ...chased, ...auto };
}

// Advisory lock transacional: em várias instâncias (Railway) só uma roda.
async function runGuarded(reason) {
    try {
        await sequelize.transaction(async (t) => {
            const rows = await sequelize.query(
                'SELECT pg_try_advisory_xact_lock(:k) AS locked',
                { replacements: { k: LOCK_KEY }, type: db.Sequelize.QueryTypes.SELECT, transaction: t }
            );
            if (!rows?.[0]?.locked) {
                console.log(`📅 [EventPlanCycle] ${reason}: outra execução em andamento, pulando.`);
                return;
            }
            await runCycle();
        });
    } catch (err) {
        console.error(`[EventPlanCycle] ${reason} falhou:`, err?.message);
    }
}

class EventPlanCycleScheduler {
    constructor() {
        this.task = null;
    }

    start() {
        this.task = cron.schedule(CYCLE_CRON, async () => {
            await runGuarded('cron diário');
        }, { timezone: TIMEZONE });

        console.log(`✅ EventPlanCycleScheduler: ciclo=${CYCLE_CRON} (${TIMEZONE})`);

        // Catch-up no startup: cobre o servidor fora do ar no dia da abertura.
        runGuarded('catch-up startup');
    }

    stop() {
        this.task?.stop();
        console.log('⛔ EventPlanCycleScheduler parado');
    }

    async runOnce() {
        return runGuarded('runOnce manual');
    }
}

export default new EventPlanCycleScheduler();

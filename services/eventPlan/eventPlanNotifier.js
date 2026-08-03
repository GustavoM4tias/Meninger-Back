// services/eventPlan/eventPlanNotifier.js
//
// Avisos do fluxo do Plano de Eventos. Isolado do motor de decisão de propósito:
// notificação NUNCA pode derrubar a transação que grava a decisão. Todas as
// funções daqui engolem o próprio erro e só logam.

import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';
import { getStages } from './eventPlanService.js';

const { EventPlanAuthProfile, CvEnterprise } = db;

const PLAN_LINK = (planId) => `/comercial/plano-eventos?plan=${planId}`;

function monthLabel(referenceMonth) {
    const [year, month] = String(referenceMonth || '').split('-');
    const names = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
        'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
    const idx = Number(month) - 1;
    return names[idx] ? `${names[idx]}/${year}` : String(referenceMonth || '');
}

async function enterpriseName(idempreendimento) {
    const e = await CvEnterprise.findByPk(idempreendimento, { attributes: ['nome'] });
    return e?.nome || `Empreendimento ${idempreendimento}`;
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

async function safeNotify(payload) {
    try {
        await NotificationService.notify(payload);
    } catch (e) {
        console.error('[eventPlan notify]', payload?.type, e?.message);
    }
}

/** Gestor enviou: avisa quem valida no Comercial. */
export async function notifySubmitted(plan) {
    const users = await usersOfStage('COMERCIAL');
    if (!users.length) return;
    const name = await enterpriseName(plan.idempreendimento);
    await safeNotify({
        type: NotificationType.EVENT_PLAN_SUBMITTED,
        recipients: { users },
        title: `Plano de eventos de ${name} aguardando validação`,
        body: `${monthLabel(plan.reference_month)} · ${plan.totals?.events_proposed || 0} evento(s), R$ ${Number(plan.totals?.proposed || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} propostos.`,
        data: { planId: plan.id },
        link: PLAN_LINK(plan.id),
        importance: 7,
    });
}

/**
 * Decisão de uma etapa. Avisa sempre o gestor; quando o Comercial libera,
 * avisa também quem faz o aceite no Marketing.
 */
export async function notifyDecided(plan, stage, { nextStatus }) {
    const name = await enterpriseName(plan.idempreendimento);
    const owners = (plan.owner_user_ids || []).map(Number).filter(Boolean);
    const approved = Number(plan.totals?.approved || 0);
    const summary = `${plan.totals?.events_approved || 0} de ${plan.totals?.events_proposed || 0} evento(s) aprovados · R$ ${approved.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

    if (owners.length) {
        await safeNotify({
            type: stage === 'COMERCIAL'
                ? NotificationType.EVENT_PLAN_COMERCIAL_DECIDED
                : NotificationType.EVENT_PLAN_MARKETING_DECIDED,
            recipients: { users: owners },
            title: `${stage === 'COMERCIAL' ? 'Comercial validou' : 'Marketing aceitou'} o plano de ${name}`,
            body: `${monthLabel(plan.reference_month)} · ${summary}`,
            data: { planId: plan.id, stage },
            link: PLAN_LINK(plan.id),
            importance: 7,
        });
    }

    if (stage === 'COMERCIAL' && nextStatus === 'pending_marketing') {
        const users = await usersOfStage('MARKETING');
        if (users.length) {
            await safeNotify({
                type: NotificationType.EVENT_PLAN_COMERCIAL_DECIDED,
                recipients: { users },
                title: `Plano de eventos de ${name} aguardando o Marketing`,
                body: `${monthLabel(plan.reference_month)} · ${summary}`,
                data: { planId: plan.id, stage },
                link: PLAN_LINK(plan.id),
                importance: 7,
            });
        }
    }
}

/** Devolvido: só o gestor precisa saber, com o motivo no corpo. */
export async function notifyReturned(plan, stage, comment) {
    const owners = (plan.owner_user_ids || []).map(Number).filter(Boolean);
    if (!owners.length) return;
    const name = await enterpriseName(plan.idempreendimento);
    await safeNotify({
        type: NotificationType.EVENT_PLAN_RETURNED,
        recipients: { users: owners },
        title: `Plano de eventos de ${name} devolvido para ajuste`,
        body: `${monthLabel(plan.reference_month)} · ${comment || 'Sem comentário.'}`,
        data: { planId: plan.id, stage },
        link: PLAN_LINK(plan.id),
        importance: 8,
    });
}

/** Mês fechado: gestor e ambas as etapas ficam sabendo que congelou. */
export async function notifyClosed(plan) {
    const name = await enterpriseName(plan.idempreendimento);
    const users = [...new Set([
        ...(plan.owner_user_ids || []).map(Number),
        ...(await usersOfStage('COMERCIAL')),
        ...(await usersOfStage('MARKETING')),
    ])].filter(Boolean);
    if (!users.length) return;

    await safeNotify({
        type: NotificationType.EVENT_PLAN_CLOSED,
        recipients: { users },
        title: `Mês fechado no plano de eventos de ${name}`,
        body: `${monthLabel(plan.reference_month)} · ${plan.totals?.events_approved || 0} evento(s) aprovados, R$ ${Number(plan.totals?.approved || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.`,
        data: { planId: plan.id },
        link: PLAN_LINK(plan.id),
        importance: 5,
    });
}

export default { notifySubmitted, notifyDecided, notifyReturned, notifyClosed };

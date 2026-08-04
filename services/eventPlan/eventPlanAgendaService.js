// services/eventPlan/eventPlanAgendaService.js
//
// Ponte com a tela de Eventos: ao passar pela ÚLTIMA etapa de autorização, o
// evento aprovado deixa de ser proposta e vira registro na agenda (`events`),
// já programado. Quantas etapas existem é configuração, não código.
//
// Roda FORA da transação da decisão, de propósito. Publicar na agenda é efeito
// colateral: se falhar, a decisão continua valendo e a publicação é retentada na
// próxima decisão (é idempotente — só publica quem ainda não tem event_id).

import db from '../../models/sequelize/index.js';
import { isFullyApproved } from '../../models/sequelize/eventPlan/plannedEvent.js';
import { ACTIVITY } from '../../models/sequelize/eventPlan/eventPlanActivity.js';
import { logActivity, getStages } from './eventPlanService.js';

const { EventPlan, PlannedEvent, PlannedEventItem, Event, CvEnterprise, User } = db;

const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * A descrição do evento na agenda é NOT NULL e é o que o Marketing lê primeiro.
 * Monta a partir do objetivo do gestor e da lista do que foi aprovado — assim a
 * agenda já mostra o que precisa ser providenciado, sem abrir o plano.
 */
export function buildDescription(plannedEvent, items, stages = []) {
    const parts = [];
    if (plannedEvent.objective) parts.push(plannedEvent.objective);

    const approved = items.filter(i => isFullyApproved(i, stages));
    if (approved.length) {
        const lines = approved.map((i) => {
            const value = i.approved_value == null ? i.proposed_value : i.approved_value;
            const quote = i.needs_quote ? ' (a cotar)' : '';
            return `- ${i.name}: ${money(value)}${quote}`;
        });
        const total = approved.reduce(
            (s, i) => s + Number(i.approved_value == null ? i.proposed_value : i.approved_value), 0
        );
        parts.push(`Itens aprovados:\n${lines.join('\n')}\nTotal: ${money(total)}`);
    }
    if (plannedEvent.expected_audience) parts.push(`Público estimado: ${plannedEvent.expected_audience}`);

    return parts.join('\n\n') || plannedEvent.title;
}

/**
 * Publica na agenda todos os eventos do plano que passaram por TODAS as etapas
 * configuradas e ainda não têm registro em `events`.
 *
 * @returns {Promise<{published:number, skipped:number}>}
 */
export async function publishApprovedEvents(planId, actorId = null) {
    const plan = await EventPlan.findByPk(planId);
    if (!plan) return { published: 0, skipped: 0 };

    // Vai para a agenda quem passou por TODAS as etapas configuradas. Com a fila
    // vazia (sem autorizacao nenhuma), enviar ja aprova e publica.
    const stages = await getStages();
    const events = await PlannedEvent.findAll({ where: { plan_id: plan.id } });
    const pending = events.filter(ev => !ev.event_id && isFullyApproved(ev, stages));
    if (!pending.length) return { published: 0, skipped: events.length };

    const [enterprise, owners] = await Promise.all([
        CvEnterprise.findByPk(plan.idempreendimento, { attributes: ['idempreendimento', 'nome', 'logo', 'foto'] }),
        (plan.owner_user_ids || []).length
            ? User.findAll({ where: { id: plan.owner_user_ids }, attributes: ['id', 'username', 'email'] })
            : Promise.resolve([]),
    ]);

    // O gestor que propôs é o organizador natural do evento na agenda.
    const organizers = owners.map(u => ({ type: 'user', id: u.id, name: u.username, email: u.email }));

    let published = 0;
    for (const plannedEvent of pending) {
        const items = await PlannedEventItem.findAll({ where: { planned_event_id: plannedEvent.id } });
        try {
            const created = await Event.create({
                title: plannedEvent.title,
                description: buildDescription(plannedEvent, items, stages),
                event_date: plannedEvent.event_date,
                tags: [plannedEvent.kind, 'Plano de Eventos'].filter(Boolean),
                images: [],
                address: {},
                organizers,
                notify_to: { users: [], positions: [], emails: [] },
                enterprise_id: enterprise?.idempreendimento || null,
                enterprise_name: enterprise?.nome || null,
                enterprise_logo: enterprise?.logo || enterprise?.foto || null,
            });

            await plannedEvent.update({ event_id: created.id });
            await logActivity({
                planId: plan.id,
                plannedEventId: plannedEvent.id,
                userId: actorId,
                action: ACTIVITY.EVENT_SCHEDULED,
                meta: { event_id: created.id, title: plannedEvent.title },
            });
            published += 1;
        } catch (e) {
            // Não derruba os outros: o que falhar é retentado na próxima rodada.
            console.error('[eventPlan agenda] falha ao publicar', plannedEvent.id, e?.message);
        }
    }

    return { published, skipped: events.length - published };
}

export default { publishApprovedEvents };

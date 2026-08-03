// models/sequelize/eventPlan/eventPlanActivity.js
//
// Trilha completa do plano — o "histórico de tudo". Molde do checklistActivity.
// Alimenta a timeline da tela e serve de dedupe da cobrança mensal (1 lembrete
// por dia por plano).
//
// Toda ação entra aqui: criação do plano, item adicionado ou editado, submissão,
// cada decisão, cada corte de valor, devolução, evento extra, override de
// responsável e fechamento do mês.
export const ACTIVITY = {
    PLAN_CREATED: 'plan.created',
    PLAN_SUBMITTED: 'plan.submitted',
    PLAN_RETURNED: 'plan.returned',
    PLAN_APPROVED: 'plan.approved',
    PLAN_CLOSED: 'plan.closed',
    PLAN_OWNER_OVERRIDDEN: 'plan.owner_overridden',
    EVENT_CREATED: 'event.created',
    EVENT_UPDATED: 'event.updated',
    EVENT_DELETED: 'event.deleted',
    EVENT_DECIDED: 'event.decided',
    EVENT_SCHEDULED: 'event.scheduled',      // virou registro na agenda (`events`)
    ITEM_CREATED: 'item.created',
    ITEM_UPDATED: 'item.updated',
    ITEM_DELETED: 'item.deleted',
    ITEM_DECIDED: 'item.decided',
    ITEM_VALUE_CUT: 'item.value_cut',        // aprovado por valor menor que o proposto
    ITEM_RECLASSIFIED: 'item.reclassified',  // OBRIGATORIO -> OPCIONAL na decisão
    CHASE_SENT: 'chase.sent',
};

export default (sequelize, DataTypes) => {
    const EventPlanActivity = sequelize.define('EventPlanActivity', {
        plan_id: { type: DataTypes.INTEGER, allowNull: false },
        planned_event_id: { type: DataTypes.INTEGER, allowNull: true },
        item_id: { type: DataTypes.INTEGER, allowNull: true },
        user_id: { type: DataTypes.INTEGER, allowNull: true },
        action: { type: DataTypes.STRING(60), allowNull: false },
        // Contexto livre da ação: valores antes/depois, comentário, etapa, round.
        meta: { type: DataTypes.JSONB, allowNull: true },
    }, {
        tableName: 'event_plan_activities',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['plan_id'] },
            { fields: ['planned_event_id'] },
            { fields: ['action'] },
        ],
    });

    EventPlanActivity.associate = (db) => {
        EventPlanActivity.belongsTo(db.EventPlan, { foreignKey: 'plan_id', as: 'plan' });
        if (db.User) EventPlanActivity.belongsTo(db.User, { foreignKey: 'user_id', as: 'actor', constraints: false });
    };

    return EventPlanActivity;
};

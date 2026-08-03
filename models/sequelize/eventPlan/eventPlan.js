// models/sequelize/eventPlan/eventPlan.js
//
// Plano de Eventos: proposta MENSAL de eventos de um empreendimento, feita pelo
// gestor comercial. Um plano por (empreendimento, mês).
//
// O `status` é a POSIÇÃO NO FLUXO, não o veredito: um plano `approved` pode ter
// 3 eventos aprovados e 2 reprovados. A verdade sobre o que foi aprovado está no
// status de cada evento e de cada item.
//
// ATENÇÃO ao nome `closed`: na Ficha Comercial (enterprise_conditions) `closed`
// significa "empreendimento finalizado, não evolui mais". AQUI significa "mês
// encerrado e congelado". Mesmo nome, sentido diferente — não copie a regra do
// closeCondition do enterpriseConditionController.
export const PLAN_STATUS = {
    DRAFT: 'draft',
    PENDING_COMERCIAL: 'pending_comercial',
    PENDING_MARKETING: 'pending_marketing',
    RETURNED: 'returned',
    APPROVED: 'approved',
    CLOSED: 'closed',
};

// Status em que o gestor ainda pode editar o plano.
export const EDITABLE_STATUSES = [PLAN_STATUS.DRAFT, PLAN_STATUS.RETURNED];

export default (sequelize, DataTypes) => {
    const EventPlan = sequelize.define('EventPlan', {
        idempreendimento: { type: DataTypes.INTEGER, allowNull: false },
        // Sempre o dia 1 do mês de referência ('2026-09-01').
        reference_month: { type: DataTypes.DATEONLY, allowNull: false },

        // ── Responsável ───────────────────────────────────────────────────────
        // SNAPSHOT dos gestores resolvidos da Ficha Comercial na abertura do
        // plano (condition.manager_user_id + managers dos módulos em modo
        // 'sistema'). É snapshot de propósito: trocar o gestor na ficha depois
        // não reescreve o histórico dos meses já abertos.
        owner_user_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        // ficha | manual (override do admin, sempre registrado na trilha)
        owner_source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ficha' },
        // true quando a ficha não tem gestor, ou só tem gestor em
        // manager_mode='manual' (contato externo, sem usuário do Office: não
        // loga nem recebe notificação). O plano entra na lista de pendências do
        // admin em vez de ficar sem dono em silêncio.
        owner_unresolved: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

        status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: PLAN_STATUS.DRAFT },
        // Incrementa a cada devolução + reenvio. As decisões dos rounds
        // anteriores continuam gravadas (histórico), só saem do cálculo.
        round: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },

        submitted_at: { type: DataTypes.DATE, allowNull: true },
        submitted_by: { type: DataTypes.INTEGER, allowNull: true },
        comercial_decided_at: { type: DataTypes.DATE, allowNull: true },
        comercial_decided_by: { type: DataTypes.INTEGER, allowNull: true },
        marketing_decided_at: { type: DataTypes.DATE, allowNull: true },
        marketing_decided_by: { type: DataTypes.INTEGER, allowNull: true },

        // Fechamento do mês: congela o plano, nada mais entra nem é decidido.
        closed_at: { type: DataTypes.DATE, allowNull: true },
        closed_by: { type: DataTypes.INTEGER, allowNull: true },
        closing_note: { type: DataTypes.TEXT, allowNull: true },

        // Cache de agregados p/ a listagem (recalculado a cada mudança):
        // { proposed, approved, events_proposed, events_approved, events_rejected }
        totals: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },

        created_by: { type: DataTypes.INTEGER, allowNull: true },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'event_plans',
        timestamps: true,
        underscored: true,
        indexes: [
            { unique: true, fields: ['idempreendimento', 'reference_month'], name: 'uniq_event_plan_enterprise_month' },
            { fields: ['status'] },
            { fields: ['reference_month'] },
        ],
    });

    EventPlan.associate = (db) => {
        EventPlan.hasMany(db.PlannedEvent, { foreignKey: 'plan_id', as: 'events', onDelete: 'CASCADE' });
        EventPlan.hasMany(db.EventPlanDecision, { foreignKey: 'plan_id', as: 'decisions', onDelete: 'CASCADE' });
        EventPlan.hasMany(db.EventPlanActivity, { foreignKey: 'plan_id', as: 'activities', onDelete: 'CASCADE' });
        // Refs cross-módulo: soft (constraints:false) p/ não acoplar o sync.
        if (db.CvEnterprise) EventPlan.belongsTo(db.CvEnterprise, { foreignKey: 'idempreendimento', as: 'enterprise', constraints: false });
    };

    return EventPlan;
};

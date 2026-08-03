// models/sequelize/eventPlan/eventPlanDecision.js
//
// UMA decisão, gravada por escopo e etapa. É o que diferencia este módulo das
// Aprovações de Marketing (ticket tudo-ou-nada): aqui o aprovador decide no
// PLANO, no EVENTO ou no ITEM, e pode cortar o valor sem apagar o proposto.
//
// Nada é sobrescrito: cada devolução + reenvio incrementa o `round` do plano e
// as decisões antigas continuam gravadas (mesmo mecanismo do
// ChecklistTaskApproval.round). O cálculo do estado olha só o round corrente;
// a timeline mostra todos.
export const SCOPE = { PLAN: 'PLAN', EVENT: 'EVENT', ITEM: 'ITEM' };
export const STAGE = { COMERCIAL: 'COMERCIAL', MARKETING: 'MARKETING' };

// Decisões que EXIGEM comentário — a ressalva sem motivo não ajuda ninguém.
export const COMMENT_REQUIRED = ['APPROVED_WITH_NOTES', 'REJECTED', 'RETURNED'];

export default (sequelize, DataTypes) => {
    const EventPlanDecision = sequelize.define('EventPlanDecision', {
        plan_id: { type: DataTypes.INTEGER, allowNull: false },
        scope: { type: DataTypes.STRING(10), allowNull: false },
        // id do planned_event ou do planned_event_item; null quando scope=PLAN.
        scope_id: { type: DataTypes.INTEGER, allowNull: true },
        stage: { type: DataTypes.STRING(20), allowNull: false },

        profile_id: { type: DataTypes.INTEGER, allowNull: true },
        user_id: { type: DataTypes.INTEGER, allowNull: false },
        round: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },

        // APPROVED | APPROVED_WITH_NOTES | REJECTED | RETURNED
        decision: { type: DataTypes.STRING(30), allowNull: false },
        // Só em scope=ITEM: o valor que o aprovador liberou (corte).
        approved_value: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
        comment: { type: DataTypes.TEXT, allowNull: true },

        // Registrado quando a decisão reclassificou um item OBRIGATORIO para
        // OPCIONAL (escolha explícita feita no modal de reprovação).
        reclassified_necessity: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    }, {
        tableName: 'event_plan_decisions',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['plan_id'] },
            { fields: ['plan_id', 'stage', 'round'] },
            { fields: ['scope', 'scope_id'] },
            { fields: ['user_id'] },
        ],
    });

    EventPlanDecision.associate = (db) => {
        EventPlanDecision.belongsTo(db.EventPlan, { foreignKey: 'plan_id', as: 'plan' });
        if (db.User) EventPlanDecision.belongsTo(db.User, { foreignKey: 'user_id', as: 'user', constraints: false });
        if (db.EventPlanAuthProfile) EventPlanDecision.belongsTo(db.EventPlanAuthProfile, { foreignKey: 'profile_id', as: 'profile', constraints: false });
    };

    return EventPlanDecision;
};

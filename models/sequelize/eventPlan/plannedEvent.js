// models/sequelize/eventPlan/plannedEvent.js
//
// Evento PROPOSTO dentro do plano do mês. Cada evento tem decisão própria em
// cada etapa (comercial e marketing) — o aprovador aprova 3 e reprova 2 no mesmo
// plano. Reprovado NÃO some: fica com motivo e autor, e entra no fechamento do
// mês como "proposto e não realizado, porque".
//
// `event_id` é a ponte para a tela de Eventos (`events`): preenchida no aceite
// do marketing, quando o evento é criado e programado na agenda.
export const DECISION_STATUS = {
    PENDING: 'PENDING',
    APPROVED: 'APPROVED',
    APPROVED_WITH_NOTES: 'APPROVED_WITH_NOTES',
    REJECTED: 'REJECTED',
    RETURNED: 'RETURNED',
};

// Aprovado, com ou sem ressalva, conta como aprovado para agregados e para o
// avanço de etapa.
export const APPROVED_SET = [DECISION_STATUS.APPROVED, DECISION_STATUS.APPROVED_WITH_NOTES];

export const PRIORITY = {
    ESSENCIAL: 'ESSENCIAL',
    IMPORTANTE: 'IMPORTANTE',
    DESEJAVEL: 'DESEJAVEL',
};

export default (sequelize, DataTypes) => {
    const PlannedEvent = sequelize.define('PlannedEvent', {
        plan_id: { type: DataTypes.INTEGER, allowNull: false },
        title: { type: DataTypes.STRING(250), allowNull: false },
        // Rótulo livre do tipo (evento, pedágio, blitz, ação...). Sem catálogo
        // fechado: a nomenclatura do comercial ainda vai assentar no uso real.
        kind: { type: DataTypes.STRING(60), allowNull: true },
        event_date: { type: DataTypes.DATEONLY, allowNull: false },
        // Preenchida só em evento de mais de um dia (ex.: feirão de 3 dias).
        event_end_date: { type: DataTypes.DATEONLY, allowNull: true },

        // Serve para o aprovador cortar com critério quando o mês estoura.
        priority: { type: DataTypes.STRING(20), allowNull: false, defaultValue: PRIORITY.IMPORTANTE },
        objective: { type: DataTypes.TEXT, allowNull: true },        // para que serve
        expected_audience: { type: DataTypes.INTEGER, allowNull: true }, // público estimado

        comercial_status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: DECISION_STATUS.PENDING },
        marketing_status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: DECISION_STATUS.PENDING },

        // Evento avulso incluído DEPOIS do plano aprovado (oportunidade que
        // apareceu no meio do mês). Corre o fluxo sozinho, sem reabrir os
        // eventos já aprovados nem voltar o plano inteiro para decisão.
        is_extra: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

        // Ponte para `events` (agenda/divulgação). Soft: a tela de Eventos é
        // independente e o registro lá pode ser apagado sem derrubar o histórico.
        event_id: { type: DataTypes.INTEGER, allowNull: true },

        // Cache da soma dos itens (proposto e aprovado).
        proposed_total: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
        approved_total: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },

        position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: DataTypes.INTEGER, allowNull: true },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'planned_events',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['plan_id'] },
            { fields: ['event_date'] },
            { fields: ['event_id'] },
        ],
    });

    PlannedEvent.associate = (db) => {
        PlannedEvent.belongsTo(db.EventPlan, { foreignKey: 'plan_id', as: 'plan' });
        PlannedEvent.hasMany(db.PlannedEventItem, { foreignKey: 'planned_event_id', as: 'items', onDelete: 'CASCADE' });
        if (db.Event) PlannedEvent.belongsTo(db.Event, { foreignKey: 'event_id', as: 'agendaEvent', constraints: false });
    };

    return PlannedEvent;
};

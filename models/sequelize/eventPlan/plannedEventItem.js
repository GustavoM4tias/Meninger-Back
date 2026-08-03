// models/sequelize/eventPlan/plannedEventItem.js
//
// Item de custo do evento proposto ("Café da padaria X - R$ 1.200", "Caneca
// personalizada 40un - R$ 1.400").
//
// Os dois flags são o coração da curadoria:
//  - necessity: OBRIGATORIO significa "sem esse item o evento não acontece".
//    Reprovar um item obrigatório força escolha explícita na tela (reprovar o
//    evento inteiro ou reclassificar o item como opcional) — nunca passa calado.
//  - cost_basis: ORCADO tem fornecedor e orçamento na mão; ESTIMADO é chute do
//    gestor. Item ESTIMADO aprovado vira pendência de cotação para o marketing.
//
// proposed_value e approved_value convivem: o aprovador corta o valor sem
// apagar o que foi pedido. É isso que dá ao gestor o corte E o motivo.
export const NECESSITY = {
    OBRIGATORIO: 'OBRIGATORIO',
    OPCIONAL: 'OPCIONAL',
};

export const COST_BASIS = {
    ORCADO: 'ORCADO',
    ESTIMADO: 'ESTIMADO',
};

export default (sequelize, DataTypes) => {
    const PlannedEventItem = sequelize.define('PlannedEventItem', {
        planned_event_id: { type: DataTypes.INTEGER, allowNull: false },
        name: { type: DataTypes.STRING(250), allowNull: false },
        // Rótulo do catálogo configurável (alimentação, brinde, mídia, mão de
        // obra, estrutura, taxa...). String p/ preservar o histórico quando a
        // categoria for renomeada ou desativada nas settings.
        category: { type: DataTypes.STRING(80), allowNull: true },
        description: { type: DataTypes.TEXT, allowNull: true },

        quantity: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 1 },
        unit_value: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
        // = quantity × unit_value, calculado no service (nunca confiar no front).
        proposed_value: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
        // Preenchido pelo aprovador quando corta o valor. Null = ainda não
        // decidido; igual ao proposto = aprovado sem corte.
        approved_value: { type: DataTypes.DECIMAL(15, 2), allowNull: true },

        necessity: { type: DataTypes.STRING(20), allowNull: false, defaultValue: NECESSITY.OPCIONAL },
        cost_basis: { type: DataTypes.STRING(20), allowNull: false, defaultValue: COST_BASIS.ESTIMADO },
        supplier: { type: DataTypes.STRING(200), allowNull: true },
        // Anexo do orçamento (F4). Soft ref ao bucket de upload.
        attachment_url: { type: DataTypes.TEXT, allowNull: true },

        comercial_status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'PENDING' },
        marketing_status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'PENDING' },

        // Item ESTIMADO que passou aprovado: o marketing ainda precisa cotar.
        // Derivado no service a cada decisão, materializado p/ filtrar na tela.
        needs_quote: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

        position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: DataTypes.INTEGER, allowNull: true },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'planned_event_items',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['planned_event_id'] },
            { fields: ['needs_quote'] },
        ],
    });

    PlannedEventItem.associate = (db) => {
        PlannedEventItem.belongsTo(db.PlannedEvent, { foreignKey: 'planned_event_id', as: 'plannedEvent' });
    };

    return PlannedEventItem;
};

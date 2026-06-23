export default (sequelize, DataTypes) => {
    // Régua de cobrança CONFIGURÁVEL. Cada regra é um degrau da régua: dispara um
    // lembrete relativo ao prazo (due_date) com offset, repetição, público-alvo,
    // canais e mensagem próprios. Escopo GLOBAL, por TEMPLATE ou por CHECKLIST.
    const ChecklistReminderRule = sequelize.define('ChecklistReminderRule', {
        // GLOBAL | TEMPLATE | CHECKLIST
        scope: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'GLOBAL' },
        scope_id: { type: DataTypes.INTEGER, allowNull: true }, // template_id ou checklist_id

        name: { type: DataTypes.STRING(120), allowNull: false },

        // Âncora do offset. DUE_DATE (prazo) | CONTRACTED_AT (data de contratação).
        anchor: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'DUE_DATE' },
        // Dias relativos à âncora: negativo = antes, 0 = no dia, positivo = depois (atraso).
        offset_days: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        // Repetição (ex.: em atraso, repetir a cada N dias). Null = dispara só uma vez.
        repeat_every_days: { type: DataTypes.INTEGER, allowNull: true },
        max_occurrences: { type: DataTypes.INTEGER, allowNull: true },

        // A quais classes de estado a regra se aplica (default: tudo que nao está pronto).
        apply_states: { type: DataTypes.JSONB, allowNull: false, defaultValue: ['TODO', 'IN_PROGRESS', 'BLOCKED'] },

        // Quem recebe: responsável, dono do checklist, usuários e cargos extras.
        recipients: { type: DataTypes.JSONB, allowNull: false, defaultValue: { assignee: true, owner: false, user_ids: [], roles: [] } },

        // Canais do disparo (interseccionados com a pref do usuário, salvo bypass nas settings).
        channels: { type: DataTypes.JSONB, allowNull: false, defaultValue: { inapp: true, email: true, whatsapp: false } },

        // Mensagem com placeholders: {{task}} {{checklist}} {{due}} {{daysLate}} {{daysToDue}} {{assignee}}
        title_template: { type: DataTypes.STRING(200), allowNull: true },
        body_template: { type: DataTypes.TEXT, allowNull: true },

        importance: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 6 },
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: DataTypes.INTEGER, allowNull: true },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'checklist_reminder_rules',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['scope'] },
            { fields: ['active'] },
            { fields: ['scope', 'scope_id'] },
        ],
    });

    return ChecklistReminderRule;
};

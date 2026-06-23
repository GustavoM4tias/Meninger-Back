export default (sequelize, DataTypes) => {
    // Mural de Avisos / Comunicados — broadcast curto (fora da KB), com público-alvo
    // por escopo (responsáveis/departamentos), validade, canais de notificação e
    // confirmação de ciência ("Li e estou ciente"). Os destinatários são
    // materializados em `academy_comunicado_receipts` no momento da publicação.
    const AcademyComunicado = sequelize.define('AcademyComunicado', {
        title: { type: DataTypes.STRING, allowNull: false },
        body: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },

        // INFORMATIVO | OBRIGATORIO | URGENTE
        kind: { type: DataTypes.STRING, allowNull: false, defaultValue: 'INFORMATIVO' },

        // Visibilidade ampla por tokens (igual highlights/artigos). O alcance real
        // (quem recebe + dá ciência) é definido pelos assignments/receipts.
        audience: { type: DataTypes.STRING, allowNull: false, defaultValue: 'BOTH' }, // legacy
        audiences: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },

        // Exige confirmação "Li e estou ciente".
        requiresAck: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

        pinned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 10 },

        // DRAFT | PUBLISHED | ARCHIVED
        status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'DRAFT' },

        // Janela de validade (opcional) — fora dela o comunicado não aparece no mural.
        startsAt: { type: DataTypes.DATE, allowNull: true },
        endsAt: { type: DataTypes.DATE, allowNull: true },

        // Canais de notificação disparados ao publicar.
        channels: { type: DataTypes.JSONB, allowNull: false, defaultValue: { inapp: true, email: true, whatsapp: false } },

        // Recorrência (fase futura) — guardada, ainda não processada por scheduler.
        recurrence: { type: DataTypes.JSONB, allowNull: true },

        // Link opcional (ex.: artigo da KB).
        link: { type: DataTypes.STRING, allowNull: true },

        publishedAt: { type: DataTypes.DATE, allowNull: true },
        createdByUserId: { type: DataTypes.INTEGER, allowNull: true },
        updatedByUserId: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'academy_comunicados',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['status'] },
            { fields: ['pinned'] },
            { fields: ['priority'] },
        ],
    });

    return AcademyComunicado;
};

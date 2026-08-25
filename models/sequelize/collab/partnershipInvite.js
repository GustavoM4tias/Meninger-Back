// models/sequelize/collab/partnershipInvite.js
//
// O convite para entrar junto numa tarefa.
//
// Existe por causa de uma assimetria simples: mandar alguém abaixo de você
// fazer algo é atribuição; pedir a um par ou a um superior é PEDIDO. O sistema
// tratava os dois do mesmo jeito, e o resultado era gente descobrindo que era
// responsável por algo sem nunca ter dito sim.
//
// Genérico por (escopo, escopo_id): serve ao assistente, ao Checklist e ao que
// vier depois, sem cada módulo inventar a própria caixa de convites.
export default (sequelize, DataTypes) => {
    const PartnershipInvite = sequelize.define('PartnershipInvite', {
        escopo: { type: DataTypes.STRING(30), allowNull: false, comment: 'assistente | checklist' },
        escopo_id: { type: DataTypes.STRING(60), allowNull: false, comment: 'Id do item no módulo de origem.' },
        titulo: { type: DataTypes.STRING(300), allowNull: true, comment: 'O que a pessoa vai ver antes de decidir.' },
        link: { type: DataTypes.STRING(300), allowNull: true, comment: 'Rota que abre o item para ela conferir.' },

        alvo_user_id: { type: DataTypes.INTEGER, allowNull: false },
        convidado_por_id: { type: DataTypes.INTEGER, allowNull: false },
        mensagem: { type: DataTypes.STRING(500), allowNull: true },

        estado: {
            type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pendente',
            comment: 'pendente | aceito | recusado | cancelado.',
        },
        motivo_resposta: { type: DataTypes.STRING(300), allowNull: true },
        respondido_em: { type: DataTypes.DATE, allowNull: true },

        // Ignorar não encerra: o convite volta. O contador é o que permite
        // insistir sem virar perseguição.
        lembretes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        lembrado_em: { type: DataTypes.DATE, allowNull: true },
    }, {
        tableName: 'partnership_invites',
        underscored: true,
        timestamps: true,
    });

    PartnershipInvite.associate = (models) => {
        PartnershipInvite.belongsTo(models.User, { foreignKey: 'alvo_user_id', as: 'alvo', constraints: false });
        PartnershipInvite.belongsTo(models.User, { foreignKey: 'convidado_por_id', as: 'convidadoPor', constraints: false });
    };
    return PartnershipInvite;
};

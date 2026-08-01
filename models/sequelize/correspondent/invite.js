// models/sequelize/correspondent/invite.js
//
// Convite público: o Office gera um link lp.menin.com.br/correspondente/<token>
// e a própria correspondente cadastra a equipe dela. Mesmo princípio do
// convite de imobiliária, com uma diferença: aqui o link é REUTILIZÁVEL por
// padrão, porque a correspondente costuma mandar gente em levas.
//
// A empresa é sempre escolhida por quem gera o link - a página pública nunca
// deixa o preenchedor apontar para outra empresa.

export default (sequelize, DataTypes) => {
    const CorrespondentInvite = sequelize.define('CorrespondentInvite', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        token: { type: DataTypes.STRING(64), allowNull: false, unique: true },

        company_id: { type: DataTypes.INTEGER, allowNull: false },
        cv_idempresa: { type: DataTypes.INTEGER, allowNull: false },

        // Identificação livre ("Equipe Premium - agosto").
        label: { type: DataTypes.STRING(160) },

        // invite = valendo | revoked = cancelado pelo criador
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'invite' },

        // Janela opcional. Vazio = sem prazo.
        expires_at: { type: DataTypes.DATEONLY },

        // Cada preenchimento vira uma entrada aqui, para o Office ver quem já
        // usou o link sem precisar cruzar com os lotes.
        // [{ at, quantidade, nomes: [], batch_id, ip }]
        submissions: { type: DataTypes.JSONB, defaultValue: [] },

        created_by: { type: DataTypes.INTEGER },
    }, {
        tableName: 'correspondent_invites',
        underscored: true,
        indexes: [{ fields: ['token'], unique: true }, { fields: ['company_id'] }],
    });

    CorrespondentInvite.associate = (db) => {
        if (db.User) CorrespondentInvite.belongsTo(db.User, { foreignKey: 'created_by', as: 'creator' });
        if (db.CorrespondentCompany) {
            CorrespondentInvite.belongsTo(db.CorrespondentCompany, { foreignKey: 'company_id', as: 'company' });
        }
    };

    return CorrespondentInvite;
};

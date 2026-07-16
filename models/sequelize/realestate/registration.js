// models/sequelize/realestate/registration.js
//
// Cadastro de imobiliária no CV CRM feito pelo Office. Um registro cobre os
// dois fluxos: criação interna (usuário Office preenche a tela) e convite
// público (usuário Office gera um link lp.menin.com.br/imobiliaria/<token>,
// o responsável da imobiliária preenche e o cadastro roda automaticamente).
// O vínculo com empreendimentos é definido SEMPRE pelo usuário Office (na
// criação do convite ou no form interno) — a página pública só exibe.

export default (sequelize, DataTypes) => {
    const RealEstateRegistration = sequelize.define('RealEstateRegistration', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        // Token do link público (nulo no fluxo interno). CSPRNG, uso único.
        token: { type: DataTypes.STRING(64), unique: true },

        // 'internal' = preenchido na tela do Office | 'public' = via link
        source: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'internal' },

        // invite (aguardando preenchimento do link) → processing → completed | error
        // revoked = link cancelado pelo criador antes do preenchimento.
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'invite' },

        // Identificação livre do convite ("Imobiliária do João - Sinop").
        label: { type: DataTypes.STRING(160) },

        // Empreendimentos a associar — [{ id, nome }] (id = idempreendimento CV).
        enterprises: { type: DataTypes.JSONB },

        // Dados submetidos — { imobiliaria: {...}, gerente: {...} }.
        form: { type: DataTypes.JSONB },

        // Resultado por etapa no CV — { imobiliaria, idimobiliaria_cv, usuario, associacoes }.
        result: { type: DataTypes.JSONB },

        // Última mensagem de erro do processamento (visível na tela p/ retry).
        error: { type: DataTypes.TEXT },

        created_by: { type: DataTypes.INTEGER },
        submitted_at: { type: DataTypes.DATE },
        completed_at: { type: DataTypes.DATE },
    }, {
        tableName: 'real_estate_registrations',
        underscored: true,
    });

    RealEstateRegistration.associate = (db) => {
        if (db.User) {
            RealEstateRegistration.belongsTo(db.User, { foreignKey: 'created_by', as: 'creator' });
        }
    };

    return RealEstateRegistration;
};

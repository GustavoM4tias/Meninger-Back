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
        // Link multi-uso (multi_use=true) fica em 'invite' permanente e cada
        // preenchimento gera um registro-filho (parent_id) processado à parte.
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'invite' },

        // Identificação livre do convite ("Imobiliária do João - Sinop").
        label: { type: DataTypes.STRING(160) },

        // Link reutilizável: aceita vários cadastros dentro de uma janela.
        // false (padrão) = uso único, igual ao comportamento original.
        multi_use: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

        // Janela de funcionamento do link multi-uso (DATEONLY 'YYYY-MM-DD').
        starts_at: { type: DataTypes.DATEONLY },
        ends_at: { type: DataTypes.DATEONLY },

        // Convite multi-uso: quem já enviou, para bloquear reenvio do mesmo CNPJ.
        // [{ cnpj, nome, gerente, registration_id, status, at }]
        submissions: { type: DataTypes.JSONB },

        // Registro-filho: aponta para o convite multi-uso que o originou.
        parent_id: { type: DataTypes.INTEGER },

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

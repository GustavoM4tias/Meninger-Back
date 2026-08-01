// models/sequelize/correspondent/company.js
//
// Cadastro LOCAL das empresas correspondentes. Existe porque o
// GET /v2/cadastros/correspondentes-empresas do CV está quebrado (responde
// HTTP 200 com mensagem de erro genérica), então não há como listar as
// empresas pela API. O Office guarda o que cadastrou e o operador amarra o
// `cv_idempresa` conferindo na tela do CV.
//
// `cv_idempresa` fica nulo até alguém confirmar: o POST de empresa do CV grava
// o registro mas devolve erro genérico, sem o id.

export default (sequelize, DataTypes) => {
    const CorrespondentCompany = sequelize.define('CorrespondentCompany', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        // Id da empresa no CV. Nulo = criada mas ainda não conferida na tela.
        cv_idempresa: { type: DataTypes.INTEGER, unique: true },

        nome: { type: DataTypes.STRING(160), allowNull: false },

        // Sigla da região do CRUD Empreendimentos > Regiões ("SD" = Sudeste).
        // O CV só expõe o nome completo, então a sigla é conhecimento nosso.
        regiao: { type: DataTypes.STRING(20) },

        estado: { type: DataTypes.STRING(2) },
        cidade: { type: DataTypes.STRING(120) },
        endereco: { type: DataTypes.STRING(240) },
        telefone: { type: DataTypes.STRING(40) },
        email: { type: DataTypes.STRING(160) },

        // Obrigatório na prática apesar da doc do CV dizer opcional: foi o
        // único campo que diferenciou o POST que gravou dos que falharam.
        dias_agendamento: { type: DataTypes.INTEGER, defaultValue: 5 },

        // pending = POST enviado ao CV, id ainda não confirmado
        // linked   = cv_idempresa preenchido
        // external = empresa que já existia no CV, só registrada aqui
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },

        observacao: { type: DataTypes.TEXT },
        created_by: { type: DataTypes.INTEGER },
    }, {
        tableName: 'correspondent_companies',
        underscored: true,
    });

    CorrespondentCompany.associate = (db) => {
        if (db.User) {
            CorrespondentCompany.belongsTo(db.User, { foreignKey: 'created_by', as: 'creator' });
        }
    };

    return CorrespondentCompany;
};

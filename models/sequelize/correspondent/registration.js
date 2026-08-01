// models/sequelize/correspondent/registration.js
//
// Um registro por PESSOA enviada ao CV, agrupada por `batch_id` (uma colagem
// = um lote). Guarda o resultado real, conferido por leitura: a resposta do
// POST do CV não é confiável em todo o módulo de correspondentes.
//
// Status:
//   pending    - na fila do lote, ainda não enviado
//   completed  - criado e CONFIRMADO no GET (cv_idusuario preenchido)
//   duplicate  - CV recusou com `documento_duplicado` (CPF já cadastrado)
//   error      - qualquer outra falha; permite retry

export default (sequelize, DataTypes) => {
    const CorrespondentRegistration = sequelize.define('CorrespondentRegistration', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        batch_id: { type: DataTypes.STRING(40), allowNull: false },

        // Empresa local (correspondent_companies) e o id efetivo usado no CV.
        company_id: { type: DataTypes.INTEGER },
        cv_idempresa: { type: DataTypes.INTEGER, allowNull: false },

        nome: { type: DataTypes.STRING(160), allowNull: false },
        documento: { type: DataTypes.STRING(11), allowNull: false },
        email: { type: DataTypes.STRING(160) },
        data_nasc: { type: DataTypes.DATEONLY },
        estado: { type: DataTypes.STRING(2) },
        cidade: { type: DataTypes.STRING(120) },

        // Booleano de verdade: o CV ignora a string "sim" e grava false.
        gerente: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },

        // office = cadastrado na tela | link = a própria correspondente
        // preencheu pelo link público.
        origem: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'office' },

        // Id do usuário no CV, preenchido só após confirmação por GET.
        cv_idusuario: { type: DataTypes.INTEGER },

        error: { type: DataTypes.TEXT },

        created_by: { type: DataTypes.INTEGER },
        completed_at: { type: DataTypes.DATE },
    }, {
        tableName: 'correspondent_registrations',
        underscored: true,
        indexes: [
            { fields: ['batch_id'] },
            { fields: ['cv_idempresa'] },
        ],
    });

    CorrespondentRegistration.associate = (db) => {
        if (db.User) {
            CorrespondentRegistration.belongsTo(db.User, { foreignKey: 'created_by', as: 'creator' });
        }
        if (db.CorrespondentCompany) {
            CorrespondentRegistration.belongsTo(db.CorrespondentCompany, { foreignKey: 'company_id', as: 'company' });
        }
    };

    return CorrespondentRegistration;
};

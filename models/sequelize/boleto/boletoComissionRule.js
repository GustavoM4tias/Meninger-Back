// models/sequelize/boleto/boletoComissionRule.js
// Regras de comissão embutida na série, por empreendimento do CV.
// Quando o boleto for emitido para uma reserva cujo `unidade.idempreendimento_cv`
// case com uma regra ativa, o valor da série é multiplicado por `percentual_boleto / 100`.
// Ex.: série traz R$ 10.000 mas 80% é comissão embutida → percentual_boleto = 20
// → boleto emitido por R$ 2.000.
export default (sequelize, DataTypes) => {
    const BoletoComissionRule = sequelize.define('BoletoComissionRule', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        idempreendimento_cv: {
            type: DataTypes.INTEGER,
            allowNull: false,
            comment: 'ID do empreendimento no CV (campo idempreendimento_cv da reserva).',
        },
        empreendimento_nome: {
            type: DataTypes.STRING,
            allowNull: true,
            comment: 'Cache do nome do empreendimento para exibição na UI.',
        },

        percentual_boleto: {
            type: DataTypes.DECIMAL(6, 2),
            allowNull: false,
            defaultValue: 100.00,
            comment: 'Percentual do valor da série que vai para o boleto (0–100). Ex.: 20 = boleto recebe 20% do valor da série.',
        },

        observacao: {
            type: DataTypes.TEXT,
            allowNull: true,
        },

        active: {
            type: DataTypes.BOOLEAN,
            defaultValue: true,
            allowNull: false,
        },

        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'boleto_comission_rules',
        underscored: true,
        timestamps: true,
    });

    BoletoComissionRule.associate = () => {};
    return BoletoComissionRule;
};

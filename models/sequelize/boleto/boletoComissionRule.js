// models/sequelize/boleto/boletoComissionRule.js
// Regras de comissão embutida na série, por empreendimento do CV.
//
// A comissão fora do contrato vem embutida na série de ato: o cliente paga, e
// parte daquele dinheiro é da imobiliária, não da incorporadora. Só o resto
// vira boleto/link. Há duas formas de descobrir esse resto:
//
//   modo 'cv'         → deduz a comissão que o PRÓPRIO CV informa na reserva
//                       (condicoes.valor_contrato - condicoes.valor_liquido).
//                       Exato por reserva, acompanha troca de tabela, ato
//                       negociado e venda à vista. Só vale onde a comissão cai
//                       TODA no ato: o CV informa o total da venda, não a
//                       divisão por série. Confira na tela de condições do CV
//                       que só a linha do ato tem "valor sem comissão fora do
//                       contrato" diferente do valor cheio.
//   modo 'percentual' → multiplica a série por `percentual_boleto / 100`.
//                       Forma antiga, mantida para o caso de o CV não informar
//                       a comissão. Ex.: série de R$ 10.000 com 80% de comissão
//                       embutida → percentual_boleto = 20 → boleto de R$ 2.000.
//
// O percentual fixo só fecha enquanto o ato for a mesma fração do contrato em
// toda venda do empreendimento: medido em 03/09/2026, 33 das 233 reservas do
// Verona fugiam dos 5% (ato negociado, venda à vista) e o percentual de 20%
// teria cobrado R$ 2,28 milhões a menos que o devido.
//
// `modo` null = herda: regra com percentual gravado (< 100) segue no
// 'percentual', que era como ela funcionava antes deste campo existir; as
// demais seguem `boleto_settings.comissao_modo`.
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

        modo: {
            type: DataTypes.STRING(20),
            allowNull: true,
            defaultValue: null,
            comment: "Como calcular o valor: 'cv' (deduz a comissão informada pelo CV) ou 'percentual' (usa percentual_boleto). null = herda o percentual gravado, se houver, senão boleto_settings.comissao_modo.",
        },

        percentual_boleto: {
            type: DataTypes.DECIMAL(6, 2),
            allowNull: false,
            defaultValue: 100.00,
            comment: 'Percentual do valor da série que vai para o boleto (0–100). Ex.: 20 = boleto recebe 20% do valor da série.',
        },

        max_dias_vencimento: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'Override do limite de dias corridos pro vencimento (override do boleto_settings.max_dias_vencimento). null = usa o default geral.',
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

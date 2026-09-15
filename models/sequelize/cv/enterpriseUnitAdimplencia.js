// models/sequelize/cv/enterpriseUnitAdimplencia.js
//
// ADIMPLÊNCIA PREMIADA por unidade (o "Desconto Construtora"): o valor que sai
// do preço de tabela quando o cliente paga em dia.
//
// No CV isso é um campo da UNIDADE, não da tabela de preço, e a API não o
// devolve em lugar nenhum (medido 15/09/2026: v1 lista os campos da unidade
// sem ele; v2/v3 respondem 405; nada nos raws de tabela, reserva, repasse ou
// pré-cadastro). Então o Office é o dono desse cadastro, editado pela tela.
//
// Uma linha por unidade POR PERÍODO: trocar o valor encerra a linha vigente
// (vigencia_ate) e abre outra. Assim a tabela guarda o histórico e dá para
// perguntar "quanto era a adimplência da 278 em março". O sync das tabelas de
// preço ainda congela uma cópia na própria tabela (coluna `adimplencia` de
// cv_enterprise_price_tables), para a tabela encerrada não mudar de valor se
// alguém mexer no cadastro depois.
//
//   tipo 'valor'      → `valor` é R$ por unidade
//   tipo 'percentual' → `valor` é % do preço da tabela (ex.: 5 = 5%)
export default (sequelize, DataTypes) => {
    const EnterpriseUnitAdimplencia = sequelize.define('EnterpriseUnitAdimplencia', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        idempreendimento: { type: DataTypes.INTEGER, allowNull: false },
        idunidade: { type: DataTypes.INTEGER, allowNull: false },
        tipo: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'valor' },
        valor: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
        vigencia_de: { type: DataTypes.DATEONLY, allowNull: false },
        vigencia_ate: { type: DataTypes.DATEONLY },           // null = vigente
        observacao: { type: DataTypes.STRING(255) },
        created_by: { type: DataTypes.INTEGER },
    }, {
        tableName: 'enterprise_unit_adimplencia',
        indexes: [
            { fields: ['idempreendimento', 'vigencia_de'] },
            { fields: ['idunidade', 'vigencia_ate'] },
        ],
    });

    EnterpriseUnitAdimplencia.associate = (db) => {
        EnterpriseUnitAdimplencia.belongsTo(db.CvEnterprise, { foreignKey: 'idempreendimento' });
        EnterpriseUnitAdimplencia.belongsTo(db.CvEnterpriseUnit, { foreignKey: 'idunidade' });
    };

    return EnterpriseUnitAdimplencia;
};

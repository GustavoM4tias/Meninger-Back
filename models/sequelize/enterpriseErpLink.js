// models/sequelize/enterpriseErpLink.js
//
// Vínculo MANUAL entre o empreendimento do CV e o do Sienge (ERP).
//
// Por que existe: a ponte automática depende de `idempreendimento_int` estar
// preenchido no cadastro do CV, o que gera `enterprise_cities.erp_id`. Quando
// esse campo fica vazio (preenchimento manual, feito por pessoa), a projeção
// chega ao dashboard sem ERP id e o front tentava adivinhar por semelhança de
// nome. Isso falhava calado: "RESIDENCIAL DOS ANJOS" não casa com
// "...RESIDENCIAL JARDIM DOS ANJOS...", e "TERRAS DE SÃO PAULO V" casa com a
// FASE 2 e a FASE 3 ao mesmo tempo.
//
// Com o vínculo explícito, o backend resolve o ERP id antes de entregar a
// projeção e ninguém precisa adivinhar.
//
// O casamento pode ser feito por id do CV (preferido) ou por nome do
// empreendimento como ele aparece na reserva (para os casos em que nem o id do
// CV vem consistente). Ao menos um dos dois é obrigatório.
export default (sequelize, DataTypes) => {
    return sequelize.define('EnterpriseErpLink', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        // Lado CV
        cv_enterprise_id: { type: DataTypes.INTEGER, allowNull: true },
        // Código da ETAPA (fase/módulo) no CV. É a chave preferida: no CV a
        // hierarquia é empreendimento → etapa → bloco → unidade, e no Sienge
        // cada fase é um empreendimento próprio, então é a etapa que identifica
        // o destino. Vazio = o vínculo vale para o empreendimento inteiro.
        cv_stage_id: { type: DataTypes.INTEGER, allowNull: true },

        // Nomes são apenas RÓTULO para exibição na tela. O casamento é sempre
        // por código: comparar texto mandava valor para o centro de custo
        // errado sem avisar.
        cv_enterprise_name: { type: DataTypes.STRING(255), allowNull: true },
        cv_stage_name: { type: DataTypes.STRING(255), allowNull: true },

        // Lado Sienge
        erp_enterprise_id: { type: DataTypes.INTEGER, allowNull: false },
        erp_enterprise_name: { type: DataTypes.STRING(255), allowNull: true },

        description: { type: DataTypes.STRING(255), allowNull: true },
        created_by: { type: DataTypes.STRING(120), allowNull: true },
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
    }, {
        tableName: 'enterprise_erp_links',
        underscored: true,
        timestamps: true
    })
}

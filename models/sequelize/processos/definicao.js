// models/sequelize/processos/definicao.js
//
// UM PROCESSO DA EMPRESA, COMO REGISTRO.
//
// É o "mapa mental" da pergunta que originou o módulo, e ele é tabela porque
// precisa ser lido, corrigido e explicado por gente - coisa que peso de modelo
// não permite. A Eme lê daqui para saber como a casa age.
//
// Os dois campos que carregam a decisão de produto:
//
//   autonomia       o degrau de HOJE. Sobe por ato de admin, desce sozinho.
//   autonomia_teto  o limite que este assunto nunca ultrapassa, por decisão.
//
// Nunca leia `autonomia` direto: use `efetivo()` de services/processos/
// autonomia.js, que considera o teto e o desligamento.
export default (sequelize, DataTypes) => {
    const ProcessoDefinicao = sequelize.define('ProcessoDefinicao', {
        key: { type: DataTypes.STRING(60), allowNull: false, unique: true },
        nome: { type: DataTypes.STRING(160), allowNull: false },
        dominio: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'comercial' },
        descricao: { type: DataTypes.TEXT, allowNull: true },

        gatilho: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        etapas: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        // As regras APROVADAS, cada uma com a evidência e quem aprovou. Sem a
        // procedência, seis meses depois ninguém sabe se a regra veio da
        // operação ou de um chute que alguém deixou passar numa sexta.
        regras: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        excecoes: { type: DataTypes.TEXT, allowNull: true },

        autonomia: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'observar' },
        autonomia_teto: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'propor' },
        autonomia_nota: { type: DataTypes.TEXT, allowNull: true },

        // A trava contra o vazamento pela regra: regra de evidência estreita
        // nasce estreita. Ver services/processos/escopo.js.
        alcance: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'empresa' },
        cv_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        cidades: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },

        rota: { type: DataTypes.STRING(120), allowNull: true },
        origem: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'semente' },
        enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        ordem: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        versao: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'processo_definicoes',
        underscored: true,
    });

    return ProcessoDefinicao;
};

// models/sequelize/processos/observacao.js
//
// O QUE DE FATO ACONTECEU. Matéria-prima do aprendizado.
//
// É a ÚNICA tabela do módulo que carrega escopo de acesso, e isso é o desenho
// inteiro: observação NUNCA atravessa o escopo de onde nasceu. Só uma regra
// aprovada, sustentada por evidência larga, vira conhecimento da empresa.
//
// Sem essa separação, a camada de aprendizado contorna o accessScopeService
// por dentro: o padrão do empreendimento que a pessoa A enxerga chegaria à
// pessoa B dentro de uma regra, sem nenhuma tool ter sido chamada indevidamente.
export default (sequelize, DataTypes) => {
    const ProcessoObservacao = sequelize.define('ProcessoObservacao', {
        processo_key: { type: DataTypes.STRING(60), allowNull: false },
        caso_tipo: { type: DataTypes.STRING(40), allowNull: true },
        caso_ref: { type: DataTypes.STRING(120), allowNull: true },

        cv_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        erp_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        cidades: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        user_id: { type: DataTypes.INTEGER, allowNull: true },

        visto: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        acao: { type: DataTypes.TEXT, allowNull: true },
        resultado: { type: DataTypes.STRING(40), allowNull: true },
        occurred_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    }, {
        tableName: 'processo_observacoes',
        underscored: true,
        updatedAt: false,
    });

    return ProcessoObservacao;
};

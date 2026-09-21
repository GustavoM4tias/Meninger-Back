// models/sequelize/processos/proposta.js
//
// O QUE O MOTOR QUER ACRESCENTAR AO MAPA. Espera uma pessoa, sempre.
//
// Nada entra no mapa sozinho, em nenhum degrau de autonomia. É o mesmo
// princípio que o MemoryTools já usa para a memória pessoal da Eme: ela
// PROPÕE e quem confirma é gente. Aqui a aposta é maior, então a regra é a
// mesma com mais evidência exigida.
//
// `status: 'parada'` é o estado de quem ainda não tem evidência bastante.
// Guardar em vez de descartar, porque padrão fraco hoje é regra boa no mês que
// vem - e descartar seria jogar fora exatamente o aprendizado que o módulo
// existe para acumular.
export default (sequelize, DataTypes) => {
    const ProcessoProposta = sequelize.define('ProcessoProposta', {
        processo_key: { type: DataTypes.STRING(60), allowNull: true },
        tipo: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'nova_regra' },
        // 'nova' | 'conflito' | 'duplicata' | 'fraca' (ver propostas.js)
        classe: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'nova' },

        texto: { type: DataTypes.TEXT, allowNull: false },
        confianca: { type: DataTypes.DECIMAL(4, 3), allowNull: false, defaultValue: 0 },

        // Os ids das observações que sustentam. Fica com o aprovador e NUNCA
        // entra no texto da regra, que é lido por quem não enxerga os casos.
        evidencia: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        evidencia_n: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

        alcance: { type: DataTypes.STRING(20), allowNull: true },
        alcance_motivo: { type: DataTypes.TEXT, allowNull: true },
        conflita_com: { type: DataTypes.INTEGER, allowNull: true },

        status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pendente' },
        motivo: { type: DataTypes.TEXT, allowNull: true },

        decidido_por: { type: DataTypes.INTEGER, allowNull: true },
        decidido_em: { type: DataTypes.DATE, allowNull: true },
        decisao_nota: { type: DataTypes.TEXT, allowNull: true },
    }, {
        tableName: 'processo_propostas',
        underscored: true,
    });

    return ProcessoProposta;
};

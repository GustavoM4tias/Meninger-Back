// models/sequelize/processos/acao.js
//
// O QUE O MOTOR FEZ quando tinha autonomia para agir. Trilha de auditoria.
//
// `autonomia_no_momento` fica gravado junto de propósito: o processo pode ser
// rebaixado depois, e "com que autoridade isto foi feito?" precisa continuar
// respondível seis meses depois, quando a coluna do processo já mudou.
//
// `revertida` é o gatilho do rebaixamento automático. Marcar uma ação como
// desfeita derruba o degrau do processo na hora, sem passar por aprovação:
// o custo de rebaixar à toa é uma semana pedindo confirmação; o de não
// rebaixar é a próxima ação errada sair sozinha.
export default (sequelize, DataTypes) => {
    const ProcessoAcao = sequelize.define('ProcessoAcao', {
        processo_key: { type: DataTypes.STRING(60), allowNull: false },
        autonomia_no_momento: { type: DataTypes.STRING(16), allowNull: false },

        acao: { type: DataTypes.STRING(80), allowNull: false },
        // A regra que motivou. É o que responde "esta regra é letra morta?" e
        // o que liga a ação de volta ao conhecimento que a produziu.
        regra_id: { type: DataTypes.INTEGER, allowNull: true },
        alvo_tipo: { type: DataTypes.STRING(40), allowNull: true },
        alvo_ref: { type: DataTypes.STRING(120), allowNull: true },
        detalhe: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },

        resultado: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ok' },
        erro: { type: DataTypes.TEXT, allowNull: true },

        revertida: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        revertida_por: { type: DataTypes.INTEGER, allowNull: true },
        revertida_em: { type: DataTypes.DATE, allowNull: true },
        revertida_nota: { type: DataTypes.TEXT, allowNull: true },
    }, {
        tableName: 'processo_acoes',
        underscored: true,
        updatedAt: false,
    });

    return ProcessoAcao;
};

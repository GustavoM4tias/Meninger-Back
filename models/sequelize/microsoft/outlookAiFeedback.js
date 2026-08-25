// models/sequelize/microsoft/outlookAiFeedback.js
//
// O que a pessoa achou do que a IA escreveu. É a memória do ajuste.
//
// Sem isto, a IA erra do mesmo jeito para sempre: a pessoa corrige o texto na
// fila, manda, e na próxima o modelo escreve exatamente igual - porque nada do
// que ela fez voltou para o prompt.
//
// Duas fontes de aprendizado aqui, e a segunda vale mais que a primeira:
//
//   `comentario`  o que a pessoa DISSE ("ficou formal demais", "sempre copie o
//                 Rafael nisso"). Direto e explícito.
//   corpo_original × corpo_final  o que ela FEZ. A diferença entre o texto que
//                 a IA escreveu e o que de fato saiu ensina o que nenhuma nota
//                 ensina, porque ninguém comenta o que corrige no automático.
export default (sequelize, DataTypes) => {
    const OutlookAiFeedback = sequelize.define('OutlookAiFeedback', {
        user_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'users', key: 'id' },
        },
        message_id: { type: DataTypes.STRING(500), allowNull: true },
        queue_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'Item da fila que gerou o comentário. Sem FK: a fila é limpa e o aprendizado fica.',
        },

        nota: {
            type: DataTypes.STRING(10),
            allowNull: true,
            comment: 'bom | ruim. Vazio quando a pessoa só editou, sem opinar.',
        },
        comentario: {
            type: DataTypes.STRING(1000),
            allowNull: true,
            comment: 'O que ela quer que a IA faça diferente da próxima vez.',
        },

        corpo_original: { type: DataTypes.TEXT, allowNull: true, comment: 'O que a IA escreveu.' },
        corpo_final: { type: DataTypes.TEXT, allowNull: true, comment: 'O que a pessoa deixou depois de editar.' },

        aplicado: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: true,
            comment: 'Entra no prompt das próximas redações. Desligar aposenta a lição sem apagar o registro.',
        },
    }, {
        tableName: 'outlook_ai_feedback',
        underscored: true,
        timestamps: true,
    });

    OutlookAiFeedback.associate = (models) => {
        OutlookAiFeedback.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    };
    return OutlookAiFeedback;
};

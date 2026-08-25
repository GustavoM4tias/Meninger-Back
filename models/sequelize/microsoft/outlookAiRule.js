// models/sequelize/microsoft/outlookAiRule.js
//
// As regras que a IA executa na caixa da pessoa.
//
// `chave` é a identidade estável da regra (as seis padrão nascem com chave
// conhecida, o seed é idempotente por ela). `modo` separa o que ela faz sozinha
// do que ela deixa esperando OK - e essa distinção vale mais que o interruptor:
// regra ligada em modo aprovação nunca manda nada, só escreve.
export default (sequelize, DataTypes) => {
    const OutlookAiRule = sequelize.define('OutlookAiRule', {
        user_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'users', key: 'id' },
        },
        chave: {
            type: DataTypes.STRING(60),
            allowNull: false,
            comment: 'Identidade estável (triagem, rascunho, prazos, ruido, followup, resumo, ou custom-<ts>).',
        },
        titulo: { type: DataTypes.STRING(200), allowNull: false },
        descricao: { type: DataTypes.TEXT, allowNull: true },
        icone: { type: DataTypes.STRING(60), allowNull: true },

        modo: {
            type: DataTypes.STRING(20),
            allowNull: false,
            defaultValue: 'aprovacao',
            comment: 'automatico = age sozinha · aprovacao = escreve e deixa na fila.',
        },
        ativo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

        origem: {
            type: DataTypes.STRING(20),
            allowNull: false,
            defaultValue: 'padrao',
            comment: 'padrao = veio do seed · texto = a pessoa descreveu em linguagem natural.',
        },
        texto_original: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'A frase que a pessoa escreveu, guardada como está: é ela que explica a regra depois.',
        },

        // Contagem: o total é histórico, o de hoje é o que a tela mostra. O dia
        // fica junto para o "hoje" zerar sozinho na virada, sem cron para isso.
        execucoes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        execucoes_hoje: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        dia_contagem: { type: DataTypes.DATEONLY, allowNull: true },
        ultima_execucao_em: { type: DataTypes.DATE, allowNull: true },
    }, {
        tableName: 'outlook_ai_rules',
        underscored: true,
        timestamps: true,
    });

    OutlookAiRule.associate = (models) => {
        OutlookAiRule.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    };
    return OutlookAiRule;
};

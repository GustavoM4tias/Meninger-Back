// /models/sequelize/validationHistory.js
export default (sequelize, DataTypes) => {
    const ValidationHistory = sequelize.define('ValidationHistory', {
        empreendimento: {
            type: DataTypes.STRING,
            allowNull: false
        },
        // id do empreendimento no CV: a chave; `empreendimento` é o rótulo da época
        idempreendimento_cv: { type: DataTypes.INTEGER, allowNull: true },
        cliente: {
            type: DataTypes.STRING,
            allowNull: false
        },
        status: {
            type: DataTypes.ENUM('APROVADO', 'REPROVADO', 'ERRO'),
            allowNull: false
        },
        mensagens: {
            type: DataTypes.JSON,    // armazena array de mensagens com tipo, descrição e nível
            allowNull: false
        },
        tokensUsed: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        model: {
            type: DataTypes.STRING,
            allowNull: false
        }
    }, {
        tableName: 'validation_histories',
        underscored: true
    });

    return ValidationHistory;
};

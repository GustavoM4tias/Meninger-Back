// models/sequelize/boleto/atoParcelaRodada.js
//
// Uma linha por RODADA do ciclo de parcelas (automatica das 09h ou manual pela
// tela): quando comecou, quando acabou, o que fez e o que deu errado. E o
// historico concreto que a aba Parcelas mostra - antes disso o resultado so ia
// para o log do servidor, e a rodada de 08/09/2026 caiu 6 vezes sem ninguem ver.
//
//   status  rodando | concluida | com_erros | falhou
//     concluida  todos os passos rodaram sem erro de passo (falha de boleto
//                individual conta em `falhas`, nao muda o status)
//     com_erros  algum passo registrou erro em `erros` (adesao, lembretes...)
//     falhou     o ciclo caiu antes de terminar; `erros` diz onde
export default (sequelize, DataTypes) => {
    const AtoParcelaRodada = sequelize.define('AtoParcelaRodada', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        hoje: { type: DataTypes.DATEONLY, allowNull: false, comment: 'Dia (Brasilia) que a rodada considerou como hoje.' },
        inicio: { type: DataTypes.DATE, allowNull: false },
        fim: { type: DataTypes.DATE, allowNull: true },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'rodando' },
        manual: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        user_id: { type: DataTypes.INTEGER, allowNull: true, comment: 'Quem clicou em Rodar ciclo (null = automatica).' },

        // Contagens para a tela nao precisar abrir o JSON.
        adesoes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        encerramentos: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        candidatas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        emitidas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        reemitidas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        falhas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        lembretes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        avisos: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        duracao_s: { type: DataTypes.INTEGER, allowNull: true },

        resultado: { type: DataTypes.JSONB, allowNull: true, comment: 'O objeto completo devolvido por runCiclo.' },
        erros: { type: DataTypes.JSONB, allowNull: true, comment: 'Lista de strings: erro por passo, ou o erro que derrubou o ciclo.' },
    }, {
        tableName: 'ato_parcelas_rodadas',
        underscored: true,
        timestamps: true,
    });
    return AtoParcelaRodada;
};

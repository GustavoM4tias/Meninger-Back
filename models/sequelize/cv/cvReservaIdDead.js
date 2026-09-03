// Tabela de IDs de reserva que não responderam no detalhe da API CV.
// Usada pela varredura ID-a-ID para evitar refazer chamadas em IDs inexistentes.
//
// last_status: 404/204 = morto de vez. 400 = "não existe (ainda)": o CV responde
//              400 para id que ainda vai nascer, então o id volta a ser
//              consultado com espera crescente (regra em ReservaFullSweepService).
// attempts:    quantas vezes deu 400 seguidas; define a espera até a próxima.
export default (sequelize, DataTypes) => {
    const CvReservaIdDead = sequelize.define('CvReservaIdDead', {
        idreserva:    { type: DataTypes.INTEGER, primaryKey: true },
        last_status:  { type: DataTypes.INTEGER, allowNull: true },
        attempts:     { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
        first_seen_at:{ type: DataTypes.DATE,    allowNull: true },
        last_check_at:{ type: DataTypes.DATE,    allowNull: true },
        message:      { type: DataTypes.TEXT,    allowNull: true },
    }, {
        tableName: 'cv_reserva_id_dead',
        underscored: true,
        timestamps: true,
        indexes: [
            { fields: ['last_check_at'] },
        ],
    });

    return CvReservaIdDead;
};

// Tabela de IDs de reserva que retornaram 404 no detalhe da API CV.
// Usada pela varredura ID-a-ID para evitar refazer chamadas em IDs inexistentes.
//
// last_status: código HTTP retornado na última checagem (geralmente 404).
// attempts:    contador para futuras políticas (ex.: revisitar 1x/mês após N tentativas).
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

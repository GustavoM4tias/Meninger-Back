export default (sequelize, DataTypes) => {
    // Diário de bordo: abastecimento, avaria, multa, manutenção. Nasce na
    // devolução (o formulário já perguntava as duas primeiras) e é o que
    // transforma o módulo em custo rateável por centro de custo depois.
    const VehicleLog = sequelize.define('VehicleLog', {
        vehicle_id: { type: DataTypes.INTEGER, allowNull: false },
        reservation_id: { type: DataTypes.INTEGER, allowNull: true },

        // abastecimento | avaria | multa | manutencao | observacao
        tipo: { type: DataTypes.STRING(20), allowNull: false },
        descricao: { type: DataTypes.TEXT, allowNull: true },
        valor: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
        litros: { type: DataTypes.DECIMAL(8, 2), allowNull: true },
        km: { type: DataTypes.INTEGER, allowNull: true },
        ocorrido_em: { type: DataTypes.DATE, allowNull: true },

        anexo_url: { type: DataTypes.TEXT, allowNull: true },
        created_by_user_id: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'vehicle_logs',
        timestamps: true,
        underscored: true,
        indexes: [{ fields: ['vehicle_id'] }, { fields: ['reservation_id'] }, { fields: ['tipo'] }],
    });

    VehicleLog.associate = (db) => {
        VehicleLog.belongsTo(db.Vehicle, { as: 'veiculo', foreignKey: 'vehicle_id' });
        VehicleLog.belongsTo(db.VehicleReservation, { as: 'reserva', foreignKey: 'reservation_id' });
        VehicleLog.belongsTo(db.User, { as: 'autor', foreignKey: 'created_by_user_id' });
    };

    return VehicleLog;
};

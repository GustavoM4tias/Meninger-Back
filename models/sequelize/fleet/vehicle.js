export default (sequelize, DataTypes) => {
    // Veículo da frota. Nasce plural de propósito: hoje é um carro só, mas o
    // carro reserva que a locadora entrega durante a manutenção já é um segundo
    // registro (tipo 'reserva') - sem isso o histórico de km ficaria misturado.
    const Vehicle = sequelize.define('Vehicle', {
        placa: { type: DataTypes.STRING(10), allowNull: false, unique: true },
        modelo: { type: DataTypes.STRING(120), allowNull: false },
        apelido: { type: DataTypes.STRING(60), allowNull: true },
        cor: { type: DataTypes.STRING(40), allowNull: true },
        ano: { type: DataTypes.INTEGER, allowNull: true },

        // proprio | reserva (emprestado durante manutenção do próprio)
        tipo: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'proprio' },

        // Última leitura confirmada do odômetro. Atualizada na devolução, que é
        // o único momento em que alguém olha o painel do carro de verdade.
        km_atual: { type: DataTypes.INTEGER, allowNull: true },
        km_atualizado_em: { type: DataTypes.DATE, allowNull: true },

        observacao: { type: DataTypes.TEXT, allowNull: true },
        ativo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    }, {
        tableName: 'vehicles',
        timestamps: true,
        underscored: true,
        indexes: [{ fields: ['ativo'] }],
    });

    Vehicle.associate = (db) => {
        Vehicle.hasMany(db.VehicleReservation, { as: 'reservas', foreignKey: 'vehicle_id' });
        Vehicle.hasMany(db.VehicleBlock, { as: 'bloqueios', foreignKey: 'vehicle_id' });
        Vehicle.hasMany(db.VehicleLog, { as: 'registros', foreignKey: 'vehicle_id' });
    };

    return Vehicle;
};

export default (sequelize, DataTypes) => {
    // Indisponibilidade que NÃO é reserva de ninguém: manutenção, revisão,
    // sinistro. Vive em tabela própria porque bloqueio não tem condutor, não
    // tem retirada e não pode aparecer como "uso" em relatório de km.
    const VehicleBlock = sequelize.define('VehicleBlock', {
        vehicle_id: { type: DataTypes.INTEGER, allowNull: false },
        inicio: { type: DataTypes.DATE, allowNull: false },
        fim: { type: DataTypes.DATE, allowNull: false },

        // manutencao | indisponivel
        tipo: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'manutencao' },
        motivo: { type: DataTypes.STRING(255), allowNull: true },
        observacao: { type: DataTypes.TEXT, allowNull: true },

        created_by_user_id: { type: DataTypes.INTEGER, allowNull: true },

        calendar_event_id: { type: DataTypes.TEXT, allowNull: true },
        calendar_organizer: { type: DataTypes.STRING(160), allowNull: true },
    }, {
        tableName: 'vehicle_blocks',
        timestamps: true,
        underscored: true,
        indexes: [{ fields: ['vehicle_id'] }, { fields: ['inicio'] }, { fields: ['fim'] }],
    });

    VehicleBlock.associate = (db) => {
        VehicleBlock.belongsTo(db.Vehicle, { as: 'veiculo', foreignKey: 'vehicle_id' });
        VehicleBlock.belongsTo(db.User, { as: 'autor', foreignKey: 'created_by_user_id' });
    };

    return VehicleBlock;
};

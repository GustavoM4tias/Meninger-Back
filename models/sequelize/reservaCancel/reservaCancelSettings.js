// models/sequelize/reservaCancel/reservaCancelSettings.js
// Configurações do módulo Cancelamento de Reservas (CV × Sienge) — singleton (id=1).
export default (sequelize, DataTypes) => {
    const ReservaCancelSettings = sequelize.define('ReservaCancelSettings', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        // Kill-switch geral. Enquanto false, webhooks são registrados como
        // 'skipped' (visíveis na tela, reprocessáveis) mas NADA é executado.
        active: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
            comment: 'Habilita o processamento automático dos cancelamentos.',
        },

        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'reserva_cancel_settings',
        underscored: true,
        timestamps: true,
    });

    ReservaCancelSettings.associate = () => {};
    return ReservaCancelSettings;
};

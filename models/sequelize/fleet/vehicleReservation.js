export default (sequelize, DataTypes) => {
    // Uma linha por uso do veículo, do pedido à devolução.
    //
    // Retirada e devolução NÃO são registros separados (era o desenho dos dois
    // formulários do Forms): sendo colunas da mesma linha, o km de saída e o de
    // chegada ficam juntos e a conta de quilometragem sai sem join - com dois
    // registros soltos, ninguém consegue casar saída com devolução depois.
    const VehicleReservation = sequelize.define('VehicleReservation', {
        vehicle_id: { type: DataTypes.INTEGER, allowNull: false },

        // Quem vai dirigir. Pode ser diferente de quem cadastrou (secretária
        // reservando para o diretor é o caso comum).
        user_id: { type: DataTypes.INTEGER, allowNull: false },
        created_by_user_id: { type: DataTypes.INTEGER, allowNull: true },

        // Do formulário de retirada. Lista configurável em fleet_settings.
        departamento: { type: DataTypes.STRING(60), allowNull: true },

        // Janela reservada. `fim` fecha no fim do período escolhido, então
        // 24/08 tarde termina 24/08 18:00 e não colide com 24/08 manhã.
        inicio: { type: DataTypes.DATE, allowNull: false },
        fim: { type: DataTypes.DATE, allowNull: false },

        // manha | tarde | dia | personalizado - só rótulo da tela; quem manda
        // no conflito é sempre inicio/fim.
        periodo: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'dia' },

        destino: { type: DataTypes.STRING(255), allowNull: true },
        // "a pedido do PH" - o grupo do Teams vivia disso e o dado se perdia.
        solicitado_por: { type: DataTypes.STRING(120), allowNull: true },
        observacao: { type: DataTypes.TEXT, allowNull: true },

        // reservada | em_uso | devolvida | cancelada | expirada
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'reservada' },

        // Retirada
        retirado_em: { type: DataTypes.DATE, allowNull: true },
        km_saida: { type: DataTypes.INTEGER, allowNull: true },
        // reserva | 1/4 | 1/2 | 3/4 | cheio
        combustivel_saida: { type: DataTypes.STRING(10), allowNull: true },
        avarias_saida: { type: DataTypes.TEXT, allowNull: true },
        // [{ url, path }] - a foto mora no bucket, aqui fica só o endereço.
        // O `path` é o que permite apagar depois; com a URL pública sozinha, a
        // remoção viraria adivinhação de prefixo.
        fotos_saida: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        obs_saida: { type: DataTypes.TEXT, allowNull: true },

        // Devolução
        devolvido_em: { type: DataTypes.DATE, allowNull: true },
        km_chegada: { type: DataTypes.INTEGER, allowNull: true },
        combustivel_chegada: { type: DataTypes.STRING(10), allowNull: true },
        houve_abastecimento: { type: DataTypes.BOOLEAN, allowNull: true },
        abastecimento_desc: { type: DataTypes.TEXT, allowNull: true },
        houve_avaria: { type: DataTypes.BOOLEAN, allowNull: true },
        avaria_desc: { type: DataTypes.TEXT, allowNull: true },
        obs_chegada: { type: DataTypes.TEXT, allowNull: true },
        fotos_chegada: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },

        // Cancelamento
        cancelado_em: { type: DataTypes.DATE, allowNull: true },
        cancelado_por_user_id: { type: DataTypes.INTEGER, allowNull: true },
        motivo_cancelamento: { type: DataTypes.TEXT, allowNull: true },

        // Marcadores de aviso já enviado. Colunas próprias de propósito: usar
        // um campo de texto do usuário como bandeira ("__avisado__") apagaria o
        // que a pessoa escreveu e faria o relatório mentir.
        lembrete_enviado_em: { type: DataTypes.DATE, allowNull: true },
        atraso_avisado_em: { type: DataTypes.DATE, allowNull: true },

        // Espelho no calendário Microsoft. Guardamos o id do evento E a caixa
        // que o organiza: sem a caixa, PATCH e DELETE não sabem em qual
        // /users/{id}/events mexer.
        calendar_event_id: { type: DataTypes.TEXT, allowNull: true },
        calendar_organizer: { type: DataTypes.STRING(160), allowNull: true },
        calendar_error: { type: DataTypes.TEXT, allowNull: true },
    }, {
        tableName: 'vehicle_reservations',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['vehicle_id'] },
            { fields: ['user_id'] },
            { fields: ['status'] },
            { fields: ['inicio'] },
            { fields: ['fim'] },
        ],
    });

    VehicleReservation.associate = (db) => {
        // `condutor` é quem dirige, e pode não ser quem cadastrou. A tela e os
        // avisos falam sempre do condutor.
        VehicleReservation.belongsTo(db.User, { as: 'condutor', foreignKey: 'user_id' });
        VehicleReservation.belongsTo(db.User, { as: 'cadastrante', foreignKey: 'created_by_user_id' });
        VehicleReservation.belongsTo(db.Vehicle, { as: 'veiculo', foreignKey: 'vehicle_id' });
    };

    return VehicleReservation;
};

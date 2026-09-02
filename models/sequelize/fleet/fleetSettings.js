export default (sequelize, DataTypes) => {
    // Linha única (id=1). Toda regra que a operação pode querer mudar mora
    // aqui e tem campo na tela - constante em código só como fallback.
    const FleetSettings = sequelize.define('FleetSettings', {
        // Reserva não retirada expira depois disto e libera a janela. É o que
        // impede a agenda de virar ficção.
        horas_expirar_sem_retirada: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 4 },
        max_dias_reserva: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 15 },
        antecedencia_max_dias: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 90 },
        lembrete_retirada_horas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 24 },

        // O formulário do Forms marcava tudo como obrigatório; aqui é escolha.
        exigir_km: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        exigir_combustivel: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        exigir_avarias: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        exigir_destino: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

        // Rosto na retirada: é o que amarra o registro a uma pessoa de verdade.
        exigir_face: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

        // Fotos obrigatórias do estado do veículo, nos dois momentos.
        min_fotos_saida: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
        min_fotos_chegada: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },

        // Teto de plausibilidade do odômetro. Não é meta de uso: é o limite
        // acima do qual a leitura é quase certamente erro de digitação.
        km_max_por_dia: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1000 },

        // Rótulo dos períodos: o que "manhã" e "tarde" significam no relógio.
        hora_inicio_manha: { type: DataTypes.STRING(5), allowNull: false, defaultValue: '07:00' },
        hora_fim_manha: { type: DataTypes.STRING(5), allowNull: false, defaultValue: '12:00' },
        hora_inicio_tarde: { type: DataTypes.STRING(5), allowNull: false, defaultValue: '13:00' },
        hora_fim_tarde: { type: DataTypes.STRING(5), allowNull: false, defaultValue: '18:00' },

        departamentos: {
            type: DataTypes.JSONB,
            allowNull: false,
            defaultValue: [
                'Comercial', 'Marketing', 'Administrativo', 'Diretoria',
                'Manutenção - Pós Obras', 'Suprimentos', 'Engenharia',
            ],
        },

        // Gestor da frota: regra de NEGÓCIO do módulo, não capacidade de tela
        // (a tabela de capacidades só sabe responder alçada x admin). Quem está
        // aqui cancela reserva de terceiro e bloqueia por manutenção sem ser
        // admin do Office.
        gestor_user_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },

        // Evento no calendário Microsoft
        evento_ativo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        // Caixa que ORGANIZA o evento. Vazio = a caixa do próprio condutor.
        evento_organizador_email: { type: DataTypes.STRING(160), allowNull: true },
        // alcada = todo mundo que tem a tela | nenhum = evento sem participante
        evento_participantes: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'alcada' },
        // free não pinta a agenda de ninguém de ocupado: o carro ocupado não
        // significa que a PESSOA está ocupada. busy só se a diretoria pedir.
        evento_mostrar_como: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'free' },
        evento_lembrete_minutos: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

        // Webhook de canal do Teams: o grupo atual continua recebendo aviso
        // sem depender de permissão do Graph (o app não tem escrita no Teams).
        teams_webhook_url: { type: DataTypes.TEXT, allowNull: true },
        teams_webhook_ativo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    }, {
        tableName: 'fleet_settings',
        timestamps: true,
        underscored: true,
    });

    return FleetSettings;
};

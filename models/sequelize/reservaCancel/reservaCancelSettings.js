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

        // ── Freio de rajada (superlotação) ────────────────────────────────────
        // Cancelamento em massa no CV (ex.: rotina de sincronização disparando
        // dezenas de webhooks em segundos) quase nunca é operação legítima. Com
        // o freio ligado, NENHUM caso da rajada é executado: todos ficam 'held',
        // esperando conferência humana e reprocesso pela tela.
        burst_guard_active: {
            type: DataTypes.BOOLEAN,
            defaultValue: true,
            comment: 'Habilita o freio de rajada (superlotação segura nenhum cancelamento).',
        },
        burst_window_seconds: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 300,
            comment: 'Janela de observação, em segundos, para contar cancelamentos automáticos.',
        },
        burst_max_cancels: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 10,
            comment: 'Máximo de cancelamentos automáticos tolerado na janela. Acima disso, todos ficam retidos.',
        },
        burst_settle_seconds: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 15,
            comment: 'Espera antes de agir, para o caso enxergar a rajada inteira (inclusive os primeiros).',
        },

        // ── Baixa do ato ──────────────────────────────────────────────────────
        // Desligado desde 21/08/2026, por decisão do negócio.
        //
        // Ligado, o cancelamento pedia a baixa do boleto pendente NA HORA. Numa
        // rajada como a de 20/08 (99 cancelamentos em um minuto, RESIDENCIAL
        // DOS ANJOS) isso é baixa em massa: naquele dia só não foi pior porque
        // 81 dos boletos já estavam pagos. Dois foram baixados de verdade, e
        // as reservas seguem vivas até hoje.
        //
        // Desligado, o boleto pendente continua vivo até vencer e o scheduler
        // diário o baixa pelo caminho normal (tolerancia_dias_uteis). Custo
        // aceito em troca: entre o cancelamento e o vencimento o cliente ainda
        // consegue pagar o ato de uma reserva cancelada.
        baixar_boleto_no_cancelamento: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
            allowNull: false,
            comment: 'Se true, o cancelamento pede a baixa do boleto pendente na hora. False (padrão): a baixa fica com o scheduler, depois do vencimento.',
        },

        // ── Workflow CV ───────────────────────────────────────────────────────
        situacao_pendencia_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 30,
            comment: 'Etapa CV pra onde a reserva vai quando o cancelamento é barrado/falha (Pendência).',
        },
        situacao_cancelada_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 4,
            comment: 'Etapa CV de cancelamento concluído (Cancelada). Sucesso mantém/devolve a reserva pra cá.',
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
